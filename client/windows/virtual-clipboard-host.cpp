#include "virtual-clipboard.h"
#include <windows.h>
#include <shobjidl.h>
#include <wincrypt.h>
#include <algorithm>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>
#include <limits>

// The host owns the OLE clipboard in its STA. The parent sends an offer once,
// then answers the host's synchronous range requests over private stdio pipes.
// No file bytes are requested until a clipboard consumer reads an IStream.
namespace {
bool decode64(const std::string& encoded, std::vector<BYTE>& output) {
    if (encoded.empty()) { output.clear(); return true; }
    DWORD count = 0;
    if (!CryptStringToBinaryA(encoded.c_str(), static_cast<DWORD>(encoded.size()), CRYPT_STRING_BASE64, nullptr, &count, nullptr, nullptr)) return false;
    output.resize(count);
    if (!CryptStringToBinaryA(encoded.c_str(), static_cast<DWORD>(encoded.size()), CRYPT_STRING_BASE64, output.data(), &count, nullptr, nullptr)) return false;
    output.resize(count); return true;
}
bool readFile(rdp_clipboard::File& result) {
    std::string line, encoded; unsigned long long size; int directory;
    if (!std::getline(std::cin, line)) return false;
    std::istringstream input(line);
    if (!(input >> size >> directory >> encoded) || (directory != 0 && directory != 1)) return false;
    std::vector<BYTE> bytes;
    if (!decode64(encoded, bytes) || bytes.empty() || bytes.size() > 32768) return false;
    int len = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, reinterpret_cast<const char*>(bytes.data()), static_cast<int>(bytes.size()), nullptr, 0);
    if (len <= 0) return false;
    result.path.resize(len);
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, reinterpret_cast<const char*>(bytes.data()), static_cast<int>(bytes.size()), &result.path[0], len)) return false;
    result.size = size; result.directory = directory != 0; return true;
}
}
int main() {
    std::string line;
    if (!std::getline(std::cin, line)) return 2;
    size_t count = 0; int asyncMode = 0; std::istringstream input(line);
    if (!(input >> count) || !count || count > 1000000) return 2;
    if (input >> asyncMode) { if (asyncMode != 0 && asyncMode != 1) return 2; }
    std::vector<rdp_clipboard::File> files(count);
    for (auto& file : files) if (!readFile(file)) return 2;
    if (FAILED(OleInitialize(nullptr))) return 3;
    IDataObject* object = nullptr;
    auto reader = [](size_t index, unsigned long long position, void* buffer, ULONG requested, ULONG* received) -> HRESULT {
        if (!received) return E_POINTER;
        // Keep messages bounded even if a consumer requests a very large read.
        requested = (std::min)(requested, static_cast<ULONG>(65536));
        std::cout << "READ " << index << ' ' << position << ' ' << requested << std::endl;
        std::string answer;
        if (!std::getline(std::cin, answer) || answer.empty() || answer[0] != '+') return STG_E_READFAULT;
        std::vector<BYTE> data;
        if (!decode64(answer.substr(1), data) || data.size() > requested) return STG_E_READFAULT;
        if (!data.empty()) std::memcpy(buffer, data.data(), data.size());
        *received = static_cast<ULONG>(data.size());
        return S_OK;
    };
    HRESULT hr = rdp_clipboard::CreateVirtualFiles(files, reader, &object, asyncMode != 0);
    if (SUCCEEDED(hr)) hr = OleSetClipboard(object);
    if (FAILED(hr)) { if (object) object->Release(); OleUninitialize(); return 4; }
    std::cout << "READY" << std::endl;
    // Pump COM's STA calls and stop when another app takes the clipboard.
    // Do not call OleFlushClipboard: that would force every file to download.
    UINT_PTR timer = SetTimer(nullptr, 1, 250, nullptr);
    if (!timer) { OleSetClipboard(nullptr); object->Release(); OleUninitialize(); return 5; }
    MSG message;
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        if (message.message == WM_TIMER && OleIsCurrentClipboard(object) != S_OK) {
            // A background paste may still be reading this object after the
            // clipboard changes; keep its provider alive until it finishes.
            IDataObjectAsyncCapability* async = nullptr;
            BOOL inOperation = FALSE;
            if (SUCCEEDED(object->QueryInterface(__uuidof(IDataObjectAsyncCapability), reinterpret_cast<void**>(&async)))) {
                async->InOperation(&inOperation);
                async->Release();
            }
            if (!inOperation) break;
        }
        TranslateMessage(&message); DispatchMessageW(&message);
    }
    KillTimer(nullptr, timer);
    if (OleIsCurrentClipboard(object) == S_OK) OleSetClipboard(nullptr);
    object->Release(); OleUninitialize();
    return 0;
}
