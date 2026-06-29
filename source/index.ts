import {EventEmitter} from 'events';
import {createReadStream, watch, promises} from 'fs';
import {dirname, basename} from 'path';
import {FSWatcher, Stats} from 'node:fs';
import {StringDecoder} from 'node:string_decoder';

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

function errorCode(error: unknown): string | undefined {
	return typeof error === 'object' && error !== null && 'code' in error
		? String(error.code)
		: undefined;
}

const closeWatcher = async (watcher: FSWatcher): Promise<void> => {
	await new Promise<void>(resolve => {
		watcher.once('close', resolve);
		watcher.close();
	});
};

export class TailCat extends EventEmitter {
	#cursor = 0;
	#isWatching = false;
	#isReading = false;
	#watcher: FSWatcher | undefined;
	#filePath: string;
	#internalQueue = 0;
	#tail = '';
	#decoder = new StringDecoder('utf8');

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

		this.#isWatching = true;
		this.#cursor = cursor;

		try {
			await this.processFromFileName();
		} catch (err) {
			this.#isWatching = false;
			await this.closeCurrentWatcher();
			throw err;
		}

		return;
	}

	/**
	 * Stop watching a file for changes and return the current cursor
	 *
	 * @returns cursor - The current cursor
	 */
	public async unwatch(): Promise<number> {
		this.#isWatching = false;
		await this.closeCurrentWatcher();

		return this.#cursor;
	}

	private async closeCurrentWatcher(): Promise<void> {
		const watcher = this.#watcher;

		if (!watcher) {
			return;
		}

		await closeWatcher(watcher);

		if (this.#watcher === watcher) {
			this.#watcher = undefined;
		}
	}

	private async handleWatcherError(error: unknown): Promise<void> {
		this.#internalQueue = 0;
		this.#isReading = false;
		await this.unwatch();

		if (this.listenerCount('error') > 0) {
			this.emit('error', error);
		}
	}

	private async processWatchEvent(event: string): Promise<void> {
		if (event === 'rename') {
			await this.closeCurrentWatcher();
			this.#internalQueue = 0;
			this.#isReading = false;
			this.#cursor = 0;
			this.#tail = '';
			this.#decoder = new StringDecoder('utf8');

			await this.processFromFileName();

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
				if (errorCode(err) !== 'ENOENT') {
					await this.handleWatcherError(err);
					return;
				}

				this.#internalQueue = 0;
				this.#isReading = false;
			}
		} while (this.#internalQueue !== 0);

		this.#isReading = false;
	}

	/**
	 * Watches a file and resolves when a rename event is detected for the file watched
	 *
	 * @returns - Node.js FSWatcher instance
	 */
	private async directoryWatcher(): Promise<FSWatcher> {
		const watcher = watch(dirname(this.#filePath));
		this.#watcher = watcher;

		const promise = new Promise<FSWatcher>((resolve, reject) => {
			watcher.on('change', (event, fileName) => {
				if (
					event === 'rename' &&
					fileName === basename(this.#filePath)
				) {
					resolve(watcher);
				}
			});

			watcher.on('error', err => {
				if (this.#watcher === watcher) {
					this.#watcher = undefined;
				}

				reject(err);
			});
			watcher.on('close', () => {
				if (this.#watcher === watcher) {
					this.#watcher = undefined;
				}

				resolve(watcher);
			});
		});

		return promise;
	}

	/**
	 *  Watches a file and emit all changes. This also supports non-existing files
	 */
	private async processFromFileName(): Promise<void> {
		let currentFileSize;
		let fileData: Stats | undefined;

		while (this.#isWatching) {
			try {
				fileData = await promises.stat(this.#filePath);
				currentFileSize = fileData.size;

				if (!fileData.isFile()) {
					throw Error('Can only watch files');
				}
			} catch (err) {
				if (errorCode(err) !== 'ENOENT') {
					throw err;
				}

				const watcher = await this.directoryWatcher();
				if (this.#watcher === watcher) {
					await this.closeCurrentWatcher();
				}

				continue;
			}

			break;
		}

		if (!this.#isWatching) {
			return;
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

		this.#watcher = watch(this.#filePath, event => {
			void this
				.processWatchEvent(event)
				.catch(err => this.handleWatcherError(err));
		});
	}

	/**
	 * Scans the data from a file from the current cursor until the end of the file
	 */
	private async streamFileFromCursor(): Promise<void> {
		const {size: currentFileSize} = await promises.stat(this.#filePath);

		if (currentFileSize <= 0) {
			this.#cursor = 0;
			this.#tail = '';
			this.#decoder = new StringDecoder('utf8');

			/**
			 * This can sometimes provide a value lower then 0.
			 * Skip iteration
			 */
			return;
		}

		const nextCursor = currentFileSize;

		if (this.#cursor > nextCursor) {
			this.#cursor = 0;
			this.#tail = '';
			this.#decoder = new StringDecoder('utf8');
		}

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

		let tail = this.#tail;
		let currentTail = '';

		const processStringChunk = (stringChunk: string): void => {
			let hasTail = false;

			if (!stringChunk.endsWith('\n')) {
				hasTail = true;
			}

			const chunks = stringChunk.split('\n');

			currentTail = hasTail ? (chunks.pop() as string) : '';

			if (chunks.length > 0) {
				chunks[0] = `${tail}${chunks[0]}`;
			} else {
				currentTail = `${tail}${currentTail}`;
			}

			tail = currentTail;

			for (const chunk of chunks) {
				const line = chunk.endsWith('\r') ? chunk.slice(0, -1) : chunk;

				if (!line.trim()) {
					continue;
				}

				this.emit('data', line);
			}
		};

		for await (const item of fileStream) {
			const decodedChunk = this.#decoder.write(item);
			if (!decodedChunk) {
				continue;
			}

			processStringChunk(decodedChunk);
		}

		this.#tail = tail;
		this.#cursor = nextCursor;
	}
}
