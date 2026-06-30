import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EOL} from 'node:os';
import {join} from 'node:path';
import {watch} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {appendFile, mkdir, rm, writeFile} from 'node:fs/promises';
import test, {after, afterEach, before} from 'node:test';
import {TailCat} from '../source';

const fileFolder = join(__dirname, '__test_files__');
const tailCats = new Set<TailCat>();

const createTailCat = (fileName: string): TailCat => {
	const tailCat = new TailCat(fileName);
	tailCats.add(tailCat);
	return tailCat;
};

const writeToFile = async (filePath: string): Promise<void> => {
	for (let x = 0; x <= 4; x++) {
		await appendFile(filePath, `foo_${x}${EOL}`);
	}
};

const createFile = async (fileName: string, save = true): Promise<string> => {
	const filePath = join(fileFolder, fileName);

	if (save) {
		await writeFile(filePath, '');
	}

	return filePath;
};

const errorCode = (error: unknown): string | undefined =>
	typeof error === 'object' && error !== null && 'code' in error
		? String(error.code)
		: undefined;

const closeWatcher = async (
	watcher: ReturnType<typeof watch> | undefined
): Promise<void> => {
	if (!watcher) {
		return;
	}

	await new Promise<void>(resolve => {
		watcher.once('close', resolve);
		watcher.close();
	});
};

const canWatchFileAndDirectory = async (
	file: string,
	directory: string
): Promise<boolean> => {
	let fileWatcher: ReturnType<typeof watch> | undefined;
	let directoryWatcher: ReturnType<typeof watch> | undefined;

	try {
		fileWatcher = watch(file);
		directoryWatcher = watch(directory);
		await closeWatcher(directoryWatcher);
		await closeWatcher(fileWatcher);
		return true;
	} catch (error) {
		await closeWatcher(directoryWatcher);
		await closeWatcher(fileWatcher);

		if (errorCode(error) === 'EMFILE') {
			return false;
		}

		throw error;
	}
};

const canUseTailCatDirectoryWatcher = async (
	directory: string
): Promise<boolean> => {
	const filePath = join(directory, `${randomUUID()}.watch-probe`);
	const tailCat = createTailCat(filePath);

	try {
		await Promise.all([
			tailCat.watch(),
			delay(50).then(() => writeFile(filePath, ''))
		]);
		await tailCat.unwatch();
		return true;
	} catch (error) {
		if (errorCode(error) === 'EMFILE') {
			return false;
		}

		throw error;
	} finally {
		await rm(filePath, {force: true});
	}
};

before(async () => {
	await mkdir(fileFolder, {recursive: true});
});

after(async () => {
	await rm(fileFolder, {recursive: true, force: true});
});

afterEach(async () => {
	await Promise.all(
		Array.from(tailCats, tailCat =>
			tailCat.unwatch().catch(() => undefined)
		)
	);
	tailCats.clear();
	await delay(100);
});

test('should throw an error when passing and undefined filepath', () => {
	assert.throws(() => createTailCat(undefined as any));
});

test('should throw error when trying to watch a folder', async () => {
	const tailCat = createTailCat(fileFolder);

	await assert.rejects(() => tailCat.watch(), {
		message: 'Can only watch files'
	});
});

test('should be lazy and not watch a file', async () => {
	const file = await createFile(`${randomUUID()}.txt`);
	const tailCat = createTailCat(file);

	tailCat.on('data', () => {
		assert.fail('Should fail the test');
	});

	await delay(250);
});

test('watch() method should return undefined', async () => {
	const file = await createFile(`${randomUUID()}.txt`);
	const tailCat = createTailCat(file);

	const response = await tailCat.watch();

	tailCat.on('data', () => {
		assert.fail('Should fail the test');
	});

	await tailCat.unwatch();
	await delay(250);

	assert.equal(response, undefined);
});

test('should watch a non-existing file and start reading when it is created', async t => {
	const fileName = `${randomUUID()}.txt`;
	const filePath = await createFile(fileName, false);
	const tailCat = createTailCat(filePath);

	try {
		await Promise.all([
			tailCat.watch(),
			delay(1000).then(() => createFile(fileName))
		]);
	} catch (error) {
		if (errorCode(error) === 'EMFILE') {
			t.skip('directory watchers are unavailable in this environment');
			return;
		}

		throw error;
	}

	let changes = 0;

	tailCat.on('data', line => {
		changes++;
		assert.match(line, /foo_{1}[0-5]{1,}/);
	});

	await writeToFile(filePath);
	await delay(1000);

	assert.equal(changes, 5);

	await tailCat.unwatch();
});

test('Calling watch() method with undefined cursor should set the cursor to the start of the file', async () => {
	const file = await createFile(`${randomUUID()}.txt`);
	const tailCat = createTailCat(file);

	await tailCat.watch({cursor: undefined});

	let changes = 0;

	tailCat.on('data', line => {
		changes++;
		assert.match(line, /foo_{1}[0-5]{1,}/);
	});

	await writeToFile(file);
	await delay(1000);

	assert.equal(changes, 5);

	await tailCat.unwatch();
});

test('actions should be idempotent and multiple call to watch should have no effect', async () => {
	const file = await createFile(`${randomUUID()}.txt`);
	const tailCat = createTailCat(file);

	await tailCat.watch();
	await tailCat.watch();
	await tailCat.watch();

	let changes = 0;

	tailCat.on('data', line => {
		changes++;
		assert.match(line, /foo_{1}[0-5]{1,}/);
	});

	await writeToFile(file);
	await delay(1000);

	assert.equal(changes, 5);

	await tailCat.unwatch();
});

test('actions should be idempotent and multiple calls to unwatch should have no effect', async () => {
	const file = await createFile(`${randomUUID()}.txt`);
	const tailCat = createTailCat(file);

	await tailCat.watch();

	let changes = 0;

	tailCat.on('data', line => {
		changes++;
		assert.match(line, /foo_{1}[0-5]{1,}/);
	});

	await writeToFile(file);
	await delay(1000);

	assert.equal(changes, 5);

	await tailCat.unwatch();
	await tailCat.unwatch();
	await tailCat.unwatch();
});

test('should pick up changes of the file in watch mode and emit changes', async () => {
	const file = await createFile(`${randomUUID()}.txt`);
	const tailCat = createTailCat(file);

	await tailCat.watch();

	let changes = 0;

	tailCat.on('data', line => {
		changes++;
		assert.match(line, /foo_{1}[0-5]{1,}/);
	});

	await writeToFile(file);
	await delay(1000);

	assert.equal(changes, 5);

	await tailCat.unwatch();
});

test('should reset cursor and tail when a watched file is truncated', async () => {
	const file = await createFile(`${randomUUID()}.txt`);
	const tailCat = createTailCat(file);
	const lines: string[] = [];

	await tailCat.watch();

	tailCat.on('data', line => {
		lines.push(line);
	});

	await appendFile(file, 'stale');
	await delay(1000);

	await writeFile(file, '');
	await appendFile(file, `fresh${EOL}`);
	await delay(1000);

	assert.deepEqual(lines, ['fresh']);

	await tailCat.unwatch();
});

test('should reread current contents when a watched file shrinks below the cursor', async () => {
	const file = await createFile(`${randomUUID()}.txt`);
	const tailCat = createTailCat(file);
	const lines: string[] = [];

	await tailCat.watch();

	tailCat.on('data', line => {
		lines.push(line);
	});

	await appendFile(file, `original-long-line${EOL}`);
	await delay(1000);

	await writeFile(file, `new${EOL}`);
	await delay(1000);

	assert.deepEqual(lines, ['original-long-line', 'new']);

	await tailCat.unwatch();
});

test('should eagerly read the data when data added while tailcat is paused and the cursor is lower then the file size provided', async () => {
	const file = await createFile(`${randomUUID()}.txt`);
	const tailCat = createTailCat(file);

	await tailCat.watch();

	let changes = 0;

	tailCat.on('data', line => {
		changes++;
		assert.match(line, /foo_{1}[0-5]{1,}/);
	});

	await writeToFile(file);
	await delay(1000);

	assert.equal(changes, 5);

	const cursor = await tailCat.unwatch();

	await writeToFile(file);
	await tailCat.watch({cursor});
	await delay(1000);

	assert.equal(changes, 10);

	await tailCat.unwatch();
});

test('should continue reading when the cursor provided after pausing', async () => {
	const file = await createFile(`${randomUUID()}.txt`);
	const tailCat = createTailCat(file);

	await tailCat.watch();

	let changes = 0;

	tailCat.on('data', line => {
		changes++;
		assert.match(line, /foo_{1}[0-5]{1,}/);
	});

	await writeToFile(file);
	await delay(1000);

	assert.equal(changes, 5);

	await tailCat.unwatch();
	await writeToFile(file);
	await tailCat.watch({cursor: 0});
	await delay(1000);

	assert.equal(changes, 15);

	await tailCat.unwatch();
});

test('should not crash tailcat when the file is deleted while watching', async t => {
	const file = await createFile(`${randomUUID()}.txt`);

	if (
		!(await canWatchFileAndDirectory(file, fileFolder)) ||
		!(await canUseTailCatDirectoryWatcher(fileFolder))
	) {
		t.skip('directory watchers are unavailable in this environment');
		return;
	}

	const tailCat = createTailCat(file);

	await tailCat.watch();
	await delay(1000);
	await rm(file);
	await tailCat.unwatch();

	assert.ok(true);
});

test('should emit stripped lines for CRLF endings', async () => {
	const file = await createFile(`${randomUUID()}.txt`);
	const tailCat = createTailCat(file);
	const lines: string[] = [];

	await tailCat.watch();

	tailCat.on('data', line => {
		lines.push(line);
	});

	await appendFile(file, 'first\r\n');
	await delay(1000);

	assert.deepEqual(lines, ['first']);

	await tailCat.unwatch();
});

test('should preserve UTF-8 multibyte characters split across stream chunks', async () => {
	const file = await createFile(`${randomUUID()}.txt`);
	const tailCat = createTailCat(file);
	const lines: string[] = [];

	await tailCat.watch();

	tailCat.on('data', line => {
		lines.push(line);
	});

	await appendFile(file, `${'a'.repeat(65535)}é\n`);
	await delay(1000);

	assert.equal(lines.length, 1);
	assert.equal(lines[0], `${'a'.repeat(65535)}é`);

	await tailCat.unwatch();
});

test('should preserve UTF-8 multibyte characters split across appends', async () => {
	const file = await createFile(`${randomUUID()}.txt`);
	const tailCat = createTailCat(file);
	const lines: string[] = [];

	await tailCat.watch();

	tailCat.on('data', line => {
		lines.push(line);
	});

	await appendFile(file, Buffer.from([0xc3]));
	await delay(1000);

	assert.deepEqual(lines, []);

	await appendFile(file, Buffer.from([0xa9, 0x0a]));
	await delay(1000);

	assert.deepEqual(lines, ['é']);

	await tailCat.unwatch();
});

test('should follow a watched file when it is deleted and recreated at the same path', async t => {
	const file = await createFile(`${randomUUID()}.txt`);

	if (
		!(await canWatchFileAndDirectory(file, fileFolder)) ||
		!(await canUseTailCatDirectoryWatcher(fileFolder))
	) {
		t.skip('directory watchers are unavailable in this environment');
		return;
	}

	const tailCat = createTailCat(file);

	await tailCat.watch();

	try {
		const lines: string[] = [];

		tailCat.on('data', line => {
			lines.push(line);
		});

		await rm(file);
		await writeFile(file, `recreated${EOL}`);
		await delay(1500);

		assert.deepEqual(lines, ['recreated']);
	} finally {
		await tailCat.unwatch();
	}
});

test('should emit an error when a watched file is recreated as a directory', async t => {
	const file = await createFile(`${randomUUID()}.txt`);

	if (
		!(await canWatchFileAndDirectory(file, fileFolder)) ||
		!(await canUseTailCatDirectoryWatcher(fileFolder))
	) {
		t.skip('directory watchers are unavailable in this environment');
		return;
	}

	const tailCat = createTailCat(file);
	let unhandledRejection: unknown;
	const onUnhandledRejection = (reason: unknown): void => {
		unhandledRejection = reason;
	};

	process.once('unhandledRejection', onUnhandledRejection);

	try {
		await tailCat.watch();

		const errorPromise = new Promise<Error>(resolve => {
			tailCat.once('error', error => resolve(error));
		});

		await rm(file);
		await mkdir(file);

		const error = await Promise.race([
			errorPromise,
			delay(1500).then(() => undefined)
		]);

		assert.ok(error instanceof Error);
		assert.equal(error.message, 'Can only watch files');
		assert.equal(unhandledRejection, undefined);
	} finally {
		process.removeListener('unhandledRejection', onUnhandledRejection);
		await tailCat.unwatch();
		await rm(file, {recursive: true, force: true});
	}
});
