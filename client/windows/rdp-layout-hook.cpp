// Intercept only the second key of Alt+Shift while the RDP window is foreground.
// The hook is owned by a separate short-lived process: exiting it removes the hook.
#include <windows.h>
#include <atomic>
#include <condition_variable>
#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <mutex>
#include <queue>
#include <thread>

static HWND target = nullptr;
static HHOOK hook = nullptr;
static bool captured[256] = {};
static std::mutex mutex;
static std::condition_variable ready;
static std::queue<int> events;
static std::atomic<bool> alive{true};
static DWORD mainThread;

static bool enqueue() {
  if (!alive || !mutex.try_lock()) return false;
  bool ok = events.size() < 16;
  if (ok) events.push(1);
  mutex.unlock();
  if (ok) ready.notify_one();
  return ok;
}
static bool down(int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; }
static LRESULT CALLBACK keyboard(int code, WPARAM message, LPARAM info) {
  if (code != HC_ACTION) return CallNextHookEx(hook, code, message, info);
  const auto* key = reinterpret_cast<const KBDLLHOOKSTRUCT*>(info);
  if (key->vkCode >= 256 || (key->flags & LLKHF_INJECTED)) return CallNextHookEx(hook, code, message, info);
  const auto vk = key->vkCode;
  const bool isDown = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
  const bool isUp = message == WM_KEYUP || message == WM_SYSKEYUP;
  if (captured[vk]) {
    if (isUp) captured[vk] = false;
    if (isDown || isUp) return 1;
  }
  if (!isDown || GetForegroundWindow() != target || down(VK_CONTROL)) return CallNextHookEx(hook, code, message, info);
  const bool shift = vk == VK_LSHIFT || vk == VK_RSHIFT || vk == VK_SHIFT;
  const bool alt = vk == VK_LMENU || vk == VK_RMENU || vk == VK_MENU;
  if (((shift && down(VK_MENU)) || (alt && down(VK_SHIFT))) && enqueue()) {
    captured[vk] = true;
    return 1;
  }
  return CallNextHookEx(hook, code, message, info);
}

int main(int argc, char** argv) {
  if (argc != 2) return 2;
  target = reinterpret_cast<HWND>(static_cast<uintptr_t>(_strtoui64(argv[1], nullptr, 10)));
  if (!IsWindow(target)) return 2;
  mainThread = GetCurrentThreadId();
  MSG message;
  PeekMessage(&message, nullptr, 0, 0, PM_NOREMOVE); // Create queue before starting the reader.
  hook = SetWindowsHookExW(WH_KEYBOARD_LL, keyboard, GetModuleHandleW(nullptr), 0);
  if (!hook) return 3;
  std::thread writer([] {
    HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    while (alive) {
      std::unique_lock<std::mutex> lock(mutex);
      ready.wait(lock, [] { return !alive || !events.empty(); });
      if (!alive) break;
      events.pop();
      lock.unlock();
      DWORD written = 0;
      if (!WriteFile(output, "SWITCH\n", 7, &written, nullptr) || written != 7) {
        alive = false;
        PostThreadMessage(mainThread, WM_QUIT, 0, 0);
      }
    }
  });
  // EOF on the parent's stdin closes the hook even if the Electron process crashes.
  std::thread reader([] {
    char buffer[16]; DWORD count;
    while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), buffer, sizeof(buffer), &count, nullptr) && count) {}
    alive = false;
    ready.notify_one();
    PostThreadMessage(mainThread, WM_QUIT, 0, 0);
  });
  reader.detach();
  while (GetMessage(&message, nullptr, 0, 0) > 0) { TranslateMessage(&message); DispatchMessage(&message); }
  UnhookWindowsHookEx(hook);
  alive = false;
  ready.notify_one();
  writer.join();
  return 0;
}
