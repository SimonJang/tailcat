import {EventEmitter} from 'events';
import {EOL} from 'os';
import {createReadStream, watch, promises} from 'fs';
import {dirname, basename} from 'path';
import {FSWatcher, Stats} from 'node:fs';

interface TailCatWatchInput {
	/**
	 * Cursor from where to start reading
	 */
	cursor: number;
}

function validateFileName(fileName?: string): asserts fileName is string {
	if (fileName === undefined) {
		throw Error('No file name has been passed');
	}
}

export class TailCat extends EventEmitter {
	#cursor = 0;
	#isReading = false;
	#watcher: FSWatcher | undefined;
	#filePath: string;
	#internalQueue = 0;

	constructor(fileName: string) {
		super();

		validateFileName(fileName);

		this.#filePath = fileName;
	}

	/**
	 * Start watching a file for changes
	 *
	 * @param params - Input to configure the behavior when start watching
	 */
	public async watch({
		cursor = this.#cursor
	}: Partial<TailCatWatchInput> = {}): Promise<undefined> {
		if (this.#watcher) {
			/**
			 * Enforce that multiple calls don't keep spawning multiple readers
			 */
			return;
		}

		this.#cursor = cursor;

		await this.processFromFileName();

		return;
	}

	/**
	 * Stop watching a file for changes and return the current cursor
	 *
	 * @returns cursor - The current cursor
	 */
	public async unwatch(): Promise<number> {
		this.#watcher?.close();
		this.#watcher = undefined;

		return this.#cursor;
	}

	/**
	 * Watches a file and resolves when a rename event is detected for the file watched
	 *
	 * @returns - Node.js FSWatcher instance
	 */
	private async directoryWatcher(): Promise<FSWatcher> {
		const watcher = watch(dirname(this.#filePath));

		const promise = new Promise<FSWatcher>((resolve, reject) => {
			watcher.on('change', (event, fileName) => {
				if (
					event === 'rename' &&
					fileName === basename(this.#filePath)
				) {
					resolve(watcher);
				}
			});

			watcher.on('error', err => reject(err));
		});

		return promise;
	}

	/**
	 *  Watches a file and emit all changes. This also supports non-existing files
	 */
	private async processFromFileName(): Promise<void> {
		let currentFileSize;
		let fileData: Stats | undefined;

		try {
			fileData = await promises.stat(this.#filePath);
			currentFileSize = fileData.size;

			if (!fileData?.isFile) {
				throw Error('Can only watch files');
			}
		} catch (err) {
			if (err.code !== 'ENOENT') {
				throw err;
			}

			const watcher = await this.directoryWatcher();
			watcher.close();
		}

		/**
		 * Set cursor when no cursor has been set.
		 */
		if (this.#cursor === undefined) {
			this.#cursor = currentFileSize === 0 ? 0 : currentFileSize;
		}

		/**
		 * Eagerly start reading the file. This catchup mechanism is for when a cursor is passed in the `watch()` method that is lower
		 * then the current file size
		 */
		if (this.#cursor < currentFileSize) {
			await this.streamFileFromCursor();
		}

		/**
		 * `stat` can return faulhy values. In that case, the cursor is reset
		 */
		if (this.#cursor > currentFileSize) {
			this.#cursor = currentFileSize;
		}

		/**
		 * Due to the async nature this function, we need a final check before initiating the watcher.
		 * This to insure that we don't assign too many watchers
		 */
		if (this.#watcher) {
			return;
		}

		this.#watcher = watch(this.#filePath, async event => {
			if (event === 'rename') {
				/**
				 * We're not interested in rename events
				 */
				return;
			}

			/**
			 * The algorithm in this listener makes sure that only 1 event is handled
			 */
			this.#internalQueue++;

			if (this.#isReading) {
				return;
			}

			do {
				try {
					this.#isReading = true;
					await this.streamFileFromCursor();
					this.#internalQueue--;
				} catch (err) {
					if (err.code !== 'ENOENT') {
						await this.unwatch();
						throw err;
					}

					this.#internalQueue = 0;
					this.#isReading = false;
				}
			} while (this.#internalQueue !== 0);

			this.#isReading = false;
		});
	}

	/**
	 * Scans the data from a file from the current cursor until the end of the file
	 */
	private async streamFileFromCursor(): Promise<void> {
		const {size: currentFileSize} = await promises.stat(this.#filePath);

		if (currentFileSize <= 0) {
			/**
			 * This can sometimes provide a value lower then 0.
			 * Skip iteration
			 */
			return;
		}

		const nextCursor = currentFileSize;

		if (this.#cursor >= nextCursor) {
			/**
			 * Skip iteration since nothing will be read or invalid state
			 */
			return;
		}

		const fileStream = createReadStream(this.#filePath, {
			start: this.#cursor,
			end: nextCursor
		});

		let tail = '';
		let currentTail = '';

		for await (const item of fileStream) {
			let hasTail = false;
			const stringChunk: string = item.toString();

			if (!stringChunk.endsWith(EOL)) {
				hasTail = true;
			}

			const chunks = stringChunk.split(EOL);

			currentTail = hasTail ? (chunks.pop() as string) : '';

			chunks[0] = `${tail}${chunks[0]}`;

			tail = currentTail;

			for (const chunk of chunks) {
				if (!chunk.trim()) {
					continue;
				}

				this.emit('data', chunk);
			}
		}

		this.#cursor = nextCursor;
	}
}
