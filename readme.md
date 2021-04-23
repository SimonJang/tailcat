# tailcat [![CI](https://github.com/SimonJang/tailcat/actions/workflows/ci.yml/badge.svg)](https://github.com/SimonJang/tailcat/actions/workflows/ci.yml)

> A Node.js file watcher like tail +0f

## Install

```bash
$ npm install tailcat --save
```

## Key properties

- Can watch non-existing files that still need to be created
- Can handle file deletion/removal
- 0 external dependencies
- Excellent test coverage
- Can handle fast updating files

## Usage

```js
import {TailCat} from 'tailcat'

const tailCat = new TailCat('./source/foo.txt'); // Configures the file that is watched

await tailcat.watch(); // Starts watching the file

tailcat.on('data', data => { // Event handler, will emit each line of the watched file
	//...
});

const cursor = await tailCat.unwatch(); // Stops watching the file and returns the current cursor

// ... some time passes

await tailCat.watch({cursor}); // Starts watching again from the cursor. Will eagerly read the data written during the pause if the cursor is lower then the file size.
```

## API

### `TailCat(path)`

Constructor for a tailcat instance

#### `path`

Type: `String`
Description: Path to the file. The file itself needs to be newline delimited (CSV, NDJSON, etc...)

### `watch([options]): Promise<undefined>`

Starts watching a file.

#### options.cursor

Type: `number`
Optional: `true`
Description: The cursor from there to start watching. If no cursor is provided, it will continue reading from the cursor that has stored internally in the `TailCat` instance. If no read operations have been performed yet, it will start from position 0.

### `unwatch(): Promise<number>`

Stops watching a file and returns the current cursor position.

### `on('data', (data: string) => {...})`

Emits events when a line has been processed from the watched file

## Contributions

I welcome any contributions.

## Author

- Simon Jang
