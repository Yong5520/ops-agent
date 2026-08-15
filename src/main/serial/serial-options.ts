// Pure serial-port option helpers shared by storage validation (hosts.ts) and
// the serial connection layer. No electron / serialport imports so it stays
// unit-testable everywhere.
//
// Values map onto the `serialport` npm package's open options: baudRate,
// dataBits, stopBits, parity map 1:1; flowControl is a UI-level enum that
// resolves to the rtscts / xon / xoff flags serialport expects.

import type { SerialParity, SerialFlowControl } from '../../shared/types.js';

/** Common console baud rates (network-device consoles default to 9600). */
export const BAUD_RATES = [
  1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
] as const;

export const DEFAULT_BAUD_RATE = 9600;
export const DATA_BITS_VALUES = [7, 8] as const;
export const STOP_BITS_VALUES = [1, 2] as const;
export const PARITY_VALUES: readonly SerialParity[] = ['none', 'even', 'odd'];
export const FLOW_CONTROL_VALUES: readonly SerialFlowControl[] = ['none', 'rtscts', 'xonxoff'];

export function isValidBaudRate(rate: number): boolean {
  return (BAUD_RATES as readonly number[]).includes(rate);
}

/** Serial-relevant slice of HostInput/HostConfig (structural - no import of
 * HostInput so this module stays dependency-free). */
export interface SerialHostSettings {
  serialPort?: string;
  baudRate?: number;
  dataBits?: number;
  stopBits?: number;
  parity?: string;
  flowControl?: string;
  loginRequired?: boolean;
  username?: string;
  password?: string;
}

/**
 * Validate the serial fields of a host record. Returns a user-facing error
 * message (Chinese, matching hostsStore's other validation messages) or null
 * when valid. SSH validation (auth type / key path) is NOT done here.
 */
export function validateSerialHost(settings: SerialHostSettings): string | null {
  if (!settings.serialPort || !settings.serialPort.trim()) {
    return '串口主机需要选择或填写串口（如 COM3 / /dev/ttyUSB0）';
  }
  if (settings.baudRate !== undefined && !isValidBaudRate(settings.baudRate)) {
    return `波特率 ${settings.baudRate} 不在支持列表中`;
  }
  if (
    settings.dataBits !== undefined &&
    !(DATA_BITS_VALUES as readonly number[]).includes(settings.dataBits)
  ) {
    return '数据位仅支持 7 或 8';
  }
  if (
    settings.stopBits !== undefined &&
    !(STOP_BITS_VALUES as readonly number[]).includes(settings.stopBits)
  ) {
    return '停止位仅支持 1 或 2';
  }
  if (settings.parity !== undefined && !PARITY_VALUES.includes(settings.parity as SerialParity)) {
    return '校验仅支持 none / even / odd';
  }
  if (
    settings.flowControl !== undefined &&
    !FLOW_CONTROL_VALUES.includes(settings.flowControl as SerialFlowControl)
  ) {
    return '流控仅支持 none / rtscts / xonxoff';
  }
  if (settings.loginRequired) {
    if (!settings.username || !settings.username.trim()) {
      return '开启账号密码登录后需要填写登录用户名';
    }
    if (!settings.password) {
      return '开启账号密码登录后需要填写登录密码';
    }
  }
  return null;
}

/** serialport open options resolved from host settings (8N1 defaults). */
export interface ResolvedSerialOptions {
  path: string;
  baudRate: number;
  dataBits: 7 | 8;
  stopBits: 1 | 2;
  parity: SerialParity;
  rtscts: boolean;
  xon: boolean;
  xoff: boolean;
}

/**
 * Resolve host serial settings into `serialport` open options, applying 8N1 +
 * no-flow-control defaults for anything unset. Throws on an empty port path
 * (run validateSerialHost first for full user-facing validation).
 */
export function resolveSerialOptions(settings: SerialHostSettings): ResolvedSerialOptions {
  const path = settings.serialPort?.trim();
  if (!path) {
    throw new Error('串口路径为空，无法打开串口');
  }
  const flowControl = (settings.flowControl ?? 'none') as SerialFlowControl;
  return {
    path,
    baudRate: settings.baudRate ?? DEFAULT_BAUD_RATE,
    dataBits: (settings.dataBits ?? 8) as 7 | 8,
    stopBits: (settings.stopBits ?? 1) as 1 | 2,
    parity: (settings.parity ?? 'none') as SerialParity,
    rtscts: flowControl === 'rtscts',
    xon: flowControl === 'xonxoff',
    xoff: flowControl === 'xonxoff',
  };
}
