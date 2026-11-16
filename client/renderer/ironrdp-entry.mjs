/**
 * Точка входа для сборки встроенного RDP-клиента (ironrdp-wasm) в один IIFE-файл.
 * Собирается scripts/build-ironrdp.js → renderer/vendor/ironrdp/bundle.js
 * (ES-модули и fetch по file:// из Electron ненадёжны, поэтому используем
 * классический <script>; WASM передаётся в WebAssembly.instantiate как байты,
 * а не через fetch — никаких сетевых запросов для загрузки модуля).
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
// Путь подменяется на абсолютный через alias в build-ironrdp.js (esbuild: dataurl-лоадер)
// Содержимое: "data:application/wasm;base64,...."
// (пакет не экспортирует ./pkg/*.wasm в поле "exports")
import wasmDataUrl from 'ironrdp-wasm-wasm-binary';

/** Декодируем data:URL в байты — fetch(data:) блокируется нашим CSP (connect-src) */
const wasmBytes = (() => {
  const base64 = wasmDataUrl.slice(wasmDataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
})();

window.IronRDP = {
  /** Инициализировать WASM (одноразово). После resolve доступны классы ниже. */
  init: () => init(wasmBytes),
  setup,
  SessionBuilder,
  DesktopSize,
  Extension,
  DeviceEvent,
  InputTransaction,
  ClipboardData,
};
