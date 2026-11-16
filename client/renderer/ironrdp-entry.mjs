/**
 * Точка входа для сборки встроенного RDP-клиента (ironrdp-wasm) в один IIFE-файл.
 * Собирается scripts/build-ironrdp.js → renderer/vendor/ironrdp/bundle.js
 * (ES-модули и fetch по file:// из Electron ненадёжны, поэтому используем
 * классический <script> + wasm как data: URL).
 */
import init, {
  setup,
  SessionBuilder,
  DesktopSize,
  Extension,
  DeviceEvent,
  InputTransaction,
  ClipboardData,
} from 'ironrdp-wasm';
// Путь подменяется на абсолютный через alias в build-ironrdp.js
// (пакет не экспортирует ./pkg/*.wasm в поле "exports")
import wasmDataUrl from 'ironrdp-wasm-wasm-binary';

window.IronRDP = {
  /** Инициализировать WASM (одноразово). После resolve доступны классы ниже. */
  init: () => init(wasmDataUrl),
  setup,
  SessionBuilder,
  DesktopSize,
  Extension,
  DeviceEvent,
  InputTransaction,
  ClipboardData,
};
