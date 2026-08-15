// Unit tests for pure serial option helpers (BAUD_RATES / validation /
// resolution). serial-options.ts has no electron or serialport imports so
// these run anywhere vitest does.
import { describe, it, expect } from 'vitest';
import {
  BAUD_RATES,
  DEFAULT_BAUD_RATE,
  isValidBaudRate,
  resolveSerialOptions,
  validateSerialHost,
} from '../serial-options.js';

describe('BAUD_RATES', () => {
  it('contains the common console baud rates including 9600 and 115200', () => {
    expect(BAUD_RATES).toContain(9600);
    expect(BAUD_RATES).toContain(115200);
  });

  it('defaults to 9600 (typical network-device console speed)', () => {
    expect(DEFAULT_BAUD_RATE).toBe(9600);
    expect(isValidBaudRate(DEFAULT_BAUD_RATE)).toBe(true);
  });
});

describe('isValidBaudRate', () => {
  it('accepts rates from the list', () => {
    expect(isValidBaudRate(9600)).toBe(true);
    expect(isValidBaudRate(115200)).toBe(true);
  });

  it('rejects rates outside the list', () => {
    expect(isValidBaudRate(12345)).toBe(false);
    expect(isValidBaudRate(0)).toBe(false);
    expect(isValidBaudRate(-1)).toBe(false);
  });
});

describe('validateSerialHost', () => {
  it('returns null for a minimal valid serial host', () => {
    expect(validateSerialHost({ serialPort: 'COM3' })).toBeNull();
  });

  it('requires a serial port path', () => {
    expect(validateSerialHost({})).toMatch(/串口/);
    expect(validateSerialHost({ serialPort: '  ' })).toMatch(/串口/);
  });

  it('rejects an invalid baud rate', () => {
    expect(validateSerialHost({ serialPort: 'COM3', baudRate: 1234 })).toMatch(/波特率/);
  });

  it('rejects invalid data bits / stop bits / parity / flow control', () => {
    expect(validateSerialHost({ serialPort: 'COM3', dataBits: 6 })).toMatch(/数据位/);
    expect(validateSerialHost({ serialPort: 'COM3', stopBits: 3 })).toMatch(/停止位/);
    expect(validateSerialHost({ serialPort: 'COM3', parity: 'weird' })).toMatch(/校验/);
    expect(validateSerialHost({ serialPort: 'COM3', flowControl: 'hw' })).toMatch(/流控/);
  });

  it('requires username and password when login is enabled', () => {
    expect(validateSerialHost({ serialPort: 'COM3', loginRequired: true })).toMatch(/用户名/);
    expect(
      validateSerialHost({ serialPort: 'COM3', loginRequired: true, username: 'admin' }),
    ).toMatch(/密码/);
    expect(
      validateSerialHost({
        serialPort: 'COM3',
        loginRequired: true,
        username: 'admin',
        password: 'secret',
      }),
    ).toBeNull();
  });

  it('does not require credentials when login is disabled', () => {
    expect(validateSerialHost({ serialPort: 'COM3', loginRequired: false })).toBeNull();
  });
});

describe('resolveSerialOptions', () => {
  it('applies 8N1-no-flow-control defaults', () => {
    expect(resolveSerialOptions({ serialPort: 'COM3' })).toEqual({
      path: 'COM3',
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      rtscts: false,
      xon: false,
      xoff: false,
    });
  });

  it('maps flowControl rtscts / xonxoff to serialport flags', () => {
    expect(resolveSerialOptions({ serialPort: 'COM3', flowControl: 'rtscts' })).toMatchObject({
      rtscts: true,
      xon: false,
    });
    expect(resolveSerialOptions({ serialPort: 'COM3', flowControl: 'xonxoff' })).toMatchObject({
      rtscts: false,
      xon: true,
      xoff: true,
    });
  });

  it('passes through explicit values', () => {
    expect(
      resolveSerialOptions({
        serialPort: '/dev/ttyUSB0',
        baudRate: 115200,
        dataBits: 7,
        stopBits: 2,
        parity: 'even',
      }),
    ).toEqual({
      path: '/dev/ttyUSB0',
      baudRate: 115200,
      dataBits: 7,
      stopBits: 2,
      parity: 'even',
      rtscts: false,
      xon: false,
      xoff: false,
    });
  });

  it('throws on an empty port path', () => {
    expect(() => resolveSerialOptions({})).toThrow(/串口/);
  });
});
