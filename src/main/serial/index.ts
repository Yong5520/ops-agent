// Serial console layer barrel export.
export * from './serial-options.js';
export {
  SerialConnectionManager,
  type SerialPortLike,
  type SerialPortFactory,
  type SerialManagerOptions,
} from './serial-connection.js';
export { SerialConnectionPool, serialPool } from './serial-pool.js';
