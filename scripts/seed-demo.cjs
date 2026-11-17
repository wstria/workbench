const path = require('node:path');
const { seed } = require('../test/fixtures/demo.cjs');

if (process.argv.length !== 3) {
  console.error('Usage: npm run demo:seed -- ./workbench-demo');
  process.exitCode = 1;
} else {
  seed(path.resolve(process.argv[2])).then((files) => console.log(JSON.stringify(files, null, 2))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
