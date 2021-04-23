import {join} from 'path';
import {EOL} from 'os';
import {promises} from 'fs';
import * as fs from 'fs-extra';
import ava from 'ava';
import {v4 as uuidv4} from 'uuid';
import * as delay from 'delay';
import {TailCat} from '../source';

const fileFolder = join(__dirname, '__test_files__');
const test = ava.serial;

const writeToFile = async (filePath: string): Promise<void> => {
	const fileHandle = await promises.open(join(filePath), 'a');

	for (let x = 0; x <= 4; x++) {
		await promises.appendFile(fileHandle, Buffer.from(`foo_${x}${EOL}`));
	}

	fileHandle.close();
};

const createFile = async (fileName: string, save = true): Promise<string> => {
	const filePath = join(fileFolder, fileName);

	if (save) {
		await fs.createFile(filePath);
	}

	return filePath;
};

test.before(async () => {
	await fs.ensureDir(fileFolder);
});

test.after.always(async () => {
	try {
		await fs.remove(fileFolder);
	} catch (err) {
		return;
	}
});

test('should throw an error when passing and undefined filepath', t => {
	t.throws(() => new TailCat(undefined as any));
});

test('should throw error when trying to watch a folder', async t => {
	const tailCat = new TailCat(fileFolder);

	await t.throwsAsync(() => tailCat.watch());
});

test('should be lazy and not watch a file', async t => {
	const file = await createFile(`${uuidv4()}.txt`);
	const tailCat = new TailCat(file);

	tailCat.on('data', () => {
		t.fail('Should fail the test');
	});

	await delay(5000);
	t.pass('Tailcat has not been invoked');
});

test('watch() method should return undefined', async t => {
	const file = await createFile(`${uuidv4()}.txt`);
	const tailCat = new TailCat(file);

	const response = await tailCat.watch();

	tailCat.on('data', () => {
		t.fail('Should fail the test');
	});

	await tailCat.unwatch();

	await delay(500);

	t.is(response, undefined);
});

test('Calling watch() method with undefined cursor should set the cursor to the start of the file', async t => {
	const file = await createFile(`${uuidv4()}.txt`);
	const tailCat = new TailCat(file);

	await tailCat.watch({cursor: undefined});

	let changes = 0;

	tailCat.on('data', line => {
		changes++;
		t.regex(line, /foo_{1}[0-5]{1,}/);
	});

	await writeToFile(file);

	await delay(1500);

	t.is(changes, 5);

	await tailCat.unwatch();
});

test('actions should be idempotent and multiple call to watch should have no effect', async t => {
	const file = await createFile(`${uuidv4()}.txt`);
	const tailCat = new TailCat(file);

	await tailCat.watch();
	await tailCat.watch();
	await tailCat.watch();

	let changes = 0;

	tailCat.on('data', line => {
		changes++;
		t.regex(line, /foo_{1}[0-5]{1,}/);
	});

	await writeToFile(file);

	await delay(1500);

	t.is(changes, 5);

	await tailCat.unwatch();
});

test('actions should be idempotent and multiple calls to unwatch should have no effect', async t => {
	const file = await createFile(`${uuidv4()}.txt`);
	const tailCat = new TailCat(file);

	await tailCat.watch();

	let changes = 0;

	tailCat.on('data', line => {
		changes++;
		t.regex(line, /foo_{1}[0-5]{1,}/);
	});

	await writeToFile(file);

	await delay(1500);

	t.is(changes, 5);

	await tailCat.unwatch();
	await tailCat.unwatch();
	await tailCat.unwatch();
});

test('should pick up changes of the file in watch mode and emit changes', async t => {
	const file = await createFile(`${uuidv4()}.txt`);
	const tailCat = new TailCat(file);

	await tailCat.watch();

	let changes = 0;

	tailCat.on('data', line => {
		changes++;
		t.regex(line, /foo_{1}[0-5]{1,}/);
	});

	await writeToFile(file);

	await delay(1500);

	t.is(changes, 5);

	await tailCat.unwatch();
});

test('should watch a non-existing file and start reading when it is created', async t => {
	const fileName = `${uuidv4()}.txt`;
	const filePath = await createFile(fileName, false);
	const tailCat = new TailCat(filePath);

	await Promise.all([
		tailCat.watch(),
		delay(1500).then(() => createFile(fileName))
	]);

	let changes = 0;

	tailCat.on('data', line => {
		changes++;
		t.regex(line, /foo_{1}[0-5]{1,}/);
	});

	await writeToFile(filePath);

	await delay(1500);

	t.is(changes, 5);

	await tailCat.unwatch();
});

test('should eagerly read the data when data added while tailcat is paused and the cursor is lower then the file size provided', async t => {
	const file = await createFile(`${uuidv4()}.txt`);
	const tailCat = new TailCat(file);

	await tailCat.watch();

	let changes = 0;

	tailCat.on('data', line => {
		changes++;
		t.regex(line, /foo_{1}[0-5]{1,}/);
	});

	await writeToFile(file);

	await delay(1500);

	t.is(changes, 5);

	const cursor = await tailCat.unwatch();

	await writeToFile(file);

	await tailCat.watch({cursor});

	await delay(1500);

	t.is(changes, 10);

	await tailCat.unwatch();
});

test('should continue reading when the cursor provided after pausing', async t => {
	const file = await createFile(`${uuidv4()}.txt`);
	const tailCat = new TailCat(file);

	await tailCat.watch();

	let changes = 0;

	tailCat.on('data', line => {
		changes++;
		t.regex(line, /foo_{1}[0-5]{1,}/);
	});

	await writeToFile(file);

	await delay(1500);

	t.is(changes, 5);

	await tailCat.unwatch();

	await writeToFile(file);

	await tailCat.watch({cursor: 0});

	await delay(1500);

	t.is(changes, 15);

	await tailCat.unwatch();
});

test('should not crash tailcat when the file is deleted while watching', async t => {
	const file = await createFile(`${uuidv4()}.txt`);
	const tailCat = new TailCat(file);

	await tailCat.watch();

	await delay(1500);

	await fs.remove(file);

	await tailCat.unwatch();

	// if this statement can be reached, nothing went wrong

	t.true(true);
});
