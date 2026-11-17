const maximumBuffer = 32 * 1024 * 1024;
const maximumPixels = 4_000_000;

const keySymbols = {
  Backspace: 0xff08, Tab: 0xff09, Enter: 0xff0d, Return: 0xff0d, Escape: 0xff1b,
  Home: 0xff50, ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54,
  PageUp: 0xff55, PageDown: 0xff56, End: 0xff57, Insert: 0xff63, Delete: 0xffff,
  Shift: 0xffe1, Control: 0xffe3, Alt: 0xffe9, Meta: 0xffeb, Super: 0xffeb, CapsLock: 0xffe5,
  PrintScreen: 0xff61, Pause: 0xff13, ScrollLock: 0xff14, NumLock: 0xff7f,
};
for (let i = 1; i <= 12; i += 1) keySymbols['F' + i] = 0xffbd + i;

function keySymbol(value) {
  if (typeof value !== 'string') return undefined;
  if (Object.hasOwn(keySymbols, value)) return keySymbols[value];
  if (value === 'Space') return 32;
  if ([...value].length !== 1) return undefined;
  const code = value.codePointAt(0);
  return code >= 32 && code < 256 ? code : code >= 256 ? 0x01000000 | code : undefined;
}

function createPacketReader(socket) {
  const chunks = [];
  let bytes = 0;
  let waiting;
  let closed;

  function complete() {
    if (!waiting || bytes < waiting.length) return;
    const { length, resolve } = waiting;
    waiting = undefined;
    bytes -= length;
    const packet = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const chunk = chunks[0];
      const copied = Math.min(length - offset, chunk.length);
      chunk.copy(packet, offset, 0, copied);
      if (copied < chunk.length) chunks[0] = chunk.subarray(copied);
      else chunks.shift();
      offset += copied;
    }
    resolve(packet);
  }

  function close(error) {
    if (closed) return;
    closed = error;
    waiting?.reject(error);
    waiting = undefined;
  }

  socket.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maximumBuffer) {
      socket.destroy(new Error('Desktop stream exceeded its buffer limit.'));
      return;
    }
    chunks.push(chunk);
    complete();
  });
  socket.on('error', close);
  socket.on('close', () => close(new Error('The desktop connection closed.')));

  return (length) => {
    if (closed) return Promise.reject(closed);
    if (!length) return Promise.resolve(Buffer.alloc(0));
    if (!Number.isInteger(length) || length < 0 || length > maximumBuffer || waiting) {
      return Promise.reject(new Error('Invalid desktop stream packet.'));
    }
    return new Promise((resolve, reject) => {
      waiting = { length, resolve, reject };
      complete();
    });
  };
}

function connectComputerDisplay(socket, onError) {
  const read = createPacketReader(socket);
  const heldKeys = new Set();
  let width = 0;
  let height = 0;
  let pixels;
  let revision = 0;
  let buttons = 0;
  let lastX = 0;
  let lastY = 0;
  let updatePending = false;
  let requested = false;
  let connected = false;
  let stopped = false;
  const handshakeTimeout = setTimeout(() => socket.destroy(new Error('The guest display did not respond.')), 10_000);
  handshakeTimeout.unref();

  function resize(nextWidth, nextHeight) {
    if (nextWidth < 1 || nextHeight < 1 || nextWidth * nextHeight > maximumPixels) {
      throw new Error('The guest display resolution is too large.');
    }
    width = nextWidth;
    height = nextHeight;
    pixels = Buffer.alloc(width * height * 4);
    requested = false;
  }

  function requestFrame() {
    if (!connected || updatePending || stopped) return;
    const packet = Buffer.alloc(10);
    packet[0] = 3;
    packet[1] = Number(requested);
    packet.writeUInt16BE(width, 6);
    packet.writeUInt16BE(height, 8);
    updatePending = true;
    requested = true;
    socket.write(packet);
  }

  function key(value, down) {
    const symbol = keySymbol(value);
    if (!connected || stopped || !symbol) return;
    const packet = Buffer.alloc(8);
    packet[0] = 4;
    packet[1] = Number(down);
    packet.writeUInt32BE(symbol, 4);
    if (down) heldKeys.add(value);
    else heldKeys.delete(value);
    socket.write(packet);
  }

  function pointer(x, y, mask) {
    if (!connected || stopped) return;
    lastX = Math.max(0, Math.min(width - 1, Math.round(x)));
    lastY = Math.max(0, Math.min(height - 1, Math.round(y)));
    buttons = mask;
    const packet = Buffer.alloc(6);
    packet[0] = 5;
    packet[1] = mask;
    packet.writeUInt16BE(lastX, 2);
    packet.writeUInt16BE(lastY, 4);
    socket.write(packet);
  }

  function release() {
    for (const value of heldKeys) key(value, false);
    if (buttons) pointer(lastX, lastY, 0);
  }

  async function readUpdates() {
    while (!stopped) {
      const type = (await read(1))[0];
      if (type === 2) continue;
      if (type === 3) {
        const clipboardHead = await read(7);
        await read(clipboardHead.readUInt32BE(3));
        continue;
      }
      if (type !== 0) throw new Error('The guest sent an unsupported desktop update.');
      const header = await read(3);
      const count = header.readUInt16BE(1);
      if (count > 4096) throw new Error('The guest sent too many display rectangles.');
      for (let index = 0; index < count; index += 1) {
        const rect = await read(12);
        const x = rect.readUInt16BE(0);
        const y = rect.readUInt16BE(2);
        const w = rect.readUInt16BE(4);
        const h = rect.readUInt16BE(6);
        const format = rect.readInt32BE(8);
        if (format === -223) {
          resize(w, h);
          continue;
        }
        if (format !== 0 || x + w > width || y + h > height) {
          throw new Error('The guest sent an invalid display rectangle.');
        }
        const rowBytes = w * 4;
        const data = await read(rowBytes * h);
        for (let alpha = 3; alpha < data.length; alpha += 4) data[alpha] = 255;
        for (let row = 0; row < h; row += 1) {
          data.copy(pixels, ((y + row) * width + x) * 4, row * rowBytes, (row + 1) * rowBytes);
        }
      }
      if (count) revision += 1;
      updatePending = false;
    }
  }

  async function start() {
    const version = (await read(12)).toString('ascii');
    if (version !== 'RFB 003.008\n') throw new Error('The guest requires an unsupported desktop protocol.');
    socket.write(version);
    const choices = await read((await read(1))[0]);
    if (!choices.includes(1)) throw new Error('The guest desktop is not available over its private transport.');
    socket.write(Buffer.from([1]));
    if ((await read(4)).readUInt32BE(0) !== 0) throw new Error('The guest desktop rejected the connection.');
    socket.write(Buffer.from([1]));
    const configuration = await read(24);
    resize(configuration.readUInt16BE(0), configuration.readUInt16BE(2));
    const nameLength = configuration.readUInt32BE(20);
    if (nameLength > 4096) throw new Error('The guest sent an invalid desktop name.');
    await read(nameLength);
    // Request 32-bit little-endian true color and raw / DesktopSize rectangles.
    socket.write(Buffer.from([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]));
    const encodings = Buffer.alloc(12);
    encodings[0] = 2;
    encodings.writeUInt16BE(2, 2);
    encodings.writeInt32BE(-223, 8);
    socket.write(encodings);
    clearTimeout(handshakeTimeout);
    connected = true;
    requestFrame();
    await readUpdates();
  }

  void start().catch((error) => {
    clearTimeout(handshakeTimeout);
    if (!stopped) onError(error);
    socket.destroy();
  });

  return {
    frame() {
      requestFrame();
      return revision ? { width, height, pixels, revision } : undefined;
    },
    key,
    pointer,
    release,
    connected: () => connected && !stopped && !socket.destroyed,
    close() {
      release();
      stopped = true;
      clearTimeout(handshakeTimeout);
      socket.destroy();
    },
  };
}

module.exports = { connectComputerDisplay, keySymbol };
