#include "virtual-clipboard.h"
#include <shlobj.h>
#include <shobjidl.h>
#include <algorithm>
#include <cassert>
#include <cstring>
using namespace rdp_clipboard;
int main(int argc, char**) {
    assert(SUCCEEDED(OleInitialize(nullptr)));
    if (argc > 1) {
        IDataObject* clipboard = nullptr;
        assert(SUCCEEDED(OleGetClipboard(&clipboard)) && clipboard);
        IDataObjectAsyncCapability* async = nullptr;
        if (argc > 2) {
            assert(SUCCEEDED(clipboard->QueryInterface(__uuidof(IDataObjectAsyncCapability), reinterpret_cast<void**>(&async))) && async);
            BOOL enabled = FALSE;
            assert(SUCCEEDED(async->GetAsyncMode(&enabled)) && enabled);
            assert(SUCCEEDED(async->StartOperation(nullptr)));
        }
        FORMATETC format{static_cast<CLIPFORMAT>(RegisterClipboardFormatW(CFSTR_FILECONTENTS)), nullptr, DVASPECT_CONTENT, 0, TYMED_ISTREAM};
        STGMEDIUM medium{};
        assert(SUCCEEDED(clipboard->GetData(&format, &medium)));
        char buffer[6]{}; ULONG actual = 0;
        assert(SUCCEEDED(medium.pstm->Read(buffer, 5, &actual)) && actual == 5);
        assert(std::strcmp(buffer, "hello") == 0);
        ReleaseStgMedium(&medium);
        if (async) { assert(SUCCEEDED(async->EndOperation(S_OK, nullptr, DROPEFFECT_COPY))); async->Release(); }
        clipboard->Release(); OleUninitialize(); return 0;
    }
    IDataObject* data = nullptr;
    int calls = 0;
    const std::vector<File> files = {{L"folder", 0, true}, {L"folder\\hello.txt", 5, false}};
    auto read = [&calls](size_t index, unsigned long long offset, void* out, ULONG count, ULONG* actual) -> HRESULT {
        ++calls; assert(index == 1); const char* value = "hello";
        if (offset > 5) return E_INVALIDARG;
        *actual = static_cast<ULONG>((std::min)(static_cast<unsigned long long>(count), 5ULL - offset));
        std::memcpy(out, value + offset, *actual); return S_OK;
    };
    assert(SUCCEEDED(CreateVirtualFiles(files, read, &data)) && data);
    IDataObjectAsyncCapability* async = nullptr;
    assert(data->QueryInterface(__uuidof(IDataObjectAsyncCapability), reinterpret_cast<void**>(&async)) == E_NOINTERFACE);
    FORMATETC format{static_cast<CLIPFORMAT>(RegisterClipboardFormatW(CFSTR_FILEDESCRIPTORW)), nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
    STGMEDIUM medium{};
    assert(SUCCEEDED(data->GetData(&format, &medium)));
    auto* group = static_cast<FILEGROUPDESCRIPTORW*>(GlobalLock(medium.hGlobal));
    assert(group && group->cItems == 2 && group->fgd[1].nFileSizeLow == 5);
    assert((group->fgd[1].dwFlags & FD_PROGRESSUI) != 0);
    assert(std::wstring(group->fgd[1].cFileName) == L"folder\\hello.txt");
    GlobalUnlock(medium.hGlobal); ReleaseStgMedium(&medium);
    assert(calls == 0);
    format.cfFormat = static_cast<CLIPFORMAT>(RegisterClipboardFormatW(CFSTR_FILECONTENTS));
    format.lindex = 1; format.tymed = TYMED_ISTREAM;
    assert(SUCCEEDED(data->GetData(&format, &medium)));
    char buffer[6]{}; ULONG actual = 0;
    assert(SUCCEEDED(medium.pstm->Read(buffer, 5, &actual)) && actual == 5);
    assert(std::strcmp(buffer, "hello") == 0 && calls == 1);
    ReleaseStgMedium(&medium); data->Release();
    assert(SUCCEEDED(CreateVirtualFiles(files, read, &data, true)) && data);
    assert(SUCCEEDED(data->QueryInterface(__uuidof(IDataObjectAsyncCapability), reinterpret_cast<void**>(&async))) && async);
    BOOL value = FALSE;
    assert(SUCCEEDED(async->GetAsyncMode(&value)) && value);
    assert(SUCCEEDED(async->InOperation(&value)) && !value);
    assert(SUCCEEDED(async->StartOperation(nullptr)));
    assert(SUCCEEDED(async->InOperation(&value)) && value);
    assert(SUCCEEDED(async->EndOperation(S_OK, nullptr, DROPEFFECT_COPY)));
    assert(SUCCEEDED(async->InOperation(&value)) && !value);
    assert(SUCCEEDED(async->SetAsyncMode(FALSE)));
    assert(SUCCEEDED(async->GetAsyncMode(&value)) && !value);
    async->Release(); data->Release();
    assert(CreateVirtualFiles({{L"..\\evil", 0, false}}, read, &data) == E_INVALIDARG);
    OleUninitialize(); return 0;
}
