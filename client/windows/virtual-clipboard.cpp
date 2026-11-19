#include "virtual-clipboard.h"
#ifdef _WIN32
#include <shlobj.h>
#include <algorithm>
#include <atomic>
#include <climits>
#include <cstring>
#include <limits>
#include <memory>
#include <new>

namespace rdp_clipboard {
namespace {
struct Source { std::vector<File> files; Read read; };

class Stream final : public IStream {
    std::atomic<ULONG> refs{1};
    std::shared_ptr<Source> source;
    size_t index;
    ULONGLONG position;
public:
    Stream(std::shared_ptr<Source> s, size_t i, ULONGLONG p = 0)
        : source(std::move(s)), index(i), position(p) {}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override {
        if (!out) return E_POINTER;
        *out = nullptr;
        if (iid == IID_IUnknown || iid == IID_ISequentialStream || iid == IID_IStream) {
            *out = static_cast<IStream*>(this); AddRef(); return S_OK;
        }
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
    ULONG STDMETHODCALLTYPE Release() override { ULONG n = --refs; if (!n) delete this; return n; }
    HRESULT STDMETHODCALLTYPE Read(void* data, ULONG size, ULONG* received) override {
        if (received) *received = 0;
        if (!data && size) return STG_E_INVALIDPOINTER;
        const ULONGLONG length = source->files[index].size;
        ULONG count = static_cast<ULONG>((std::min)(static_cast<ULONGLONG>(size), length - (std::min)(position, length)));
        if (!count) return size ? S_FALSE : S_OK;
        ULONG actual = 0;
        HRESULT hr;
        try { hr = source->read(index, position, data, count, &actual); }
        catch (...) { return STG_E_READFAULT; }
        if (FAILED(hr)) return hr;
        if (actual > count || (!actual && count)) return STG_E_READFAULT;
        position += actual;
        if (received) *received = actual;
        return actual == size ? S_OK : S_FALSE;
    }
    HRESULT STDMETHODCALLTYPE Write(const void*, ULONG, ULONG*) override { return STG_E_ACCESSDENIED; }
    HRESULT STDMETHODCALLTYPE Seek(LARGE_INTEGER move, DWORD origin, ULARGE_INTEGER* result) override {
        ULONGLONG base;
        switch (origin) {
            case STREAM_SEEK_SET: base = 0; break;
            case STREAM_SEEK_CUR: base = position; break;
            case STREAM_SEEK_END: base = source->files[index].size; break;
            default: return STG_E_INVALIDFUNCTION;
        }
        ULONGLONG next;
        if (move.QuadPart < 0) {
            ULONGLONG magnitude = static_cast<ULONGLONG>(-(move.QuadPart + 1)) + 1;
            if (magnitude > base) return STG_E_INVALIDFUNCTION;
            next = base - magnitude;
        } else {
            auto amount = static_cast<ULONGLONG>(move.QuadPart);
            if (base > (std::numeric_limits<ULONGLONG>::max)() - amount) return STG_E_INVALIDFUNCTION;
            next = base + amount;
        }
        position = next;
        if (result) result->QuadPart = position;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE SetSize(ULARGE_INTEGER) override { return STG_E_ACCESSDENIED; }
    HRESULT STDMETHODCALLTYPE CopyTo(IStream* dest, ULARGE_INTEGER count, ULARGE_INTEGER* read, ULARGE_INTEGER* written) override {
        if (read) read->QuadPart = 0;
        if (written) written->QuadPart = 0;
        if (!dest) return STG_E_INVALIDPOINTER;
        BYTE buffer[65536]; ULONGLONG done = 0;
        while (done < count.QuadPart) {
            ULONG want = static_cast<ULONG>((std::min)(count.QuadPart - done, static_cast<ULONGLONG>(sizeof(buffer))));
            ULONG got = 0; HRESULT hr = Read(buffer, want, &got);
            if (FAILED(hr)) return hr;
            ULONG sent = 0;
            if (got) { HRESULT whr = dest->Write(buffer, got, &sent); if (FAILED(whr)) return whr; }
            done += got;
            if (read) read->QuadPart += got;
            if (written) written->QuadPart += sent;
            if (sent != got) return STG_E_WRITEFAULT;
            if (got < want) return S_FALSE;
        }
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE Commit(DWORD) override { return STG_E_ACCESSDENIED; }
    HRESULT STDMETHODCALLTYPE Revert() override { return STG_E_REVERTED; }
    HRESULT STDMETHODCALLTYPE LockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override { return STG_E_INVALIDFUNCTION; }
    HRESULT STDMETHODCALLTYPE UnlockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override { return STG_E_INVALIDFUNCTION; }
    HRESULT STDMETHODCALLTYPE Stat(STATSTG* stat, DWORD) override {
        if (!stat) return STG_E_INVALIDPOINTER;
        std::memset(stat, 0, sizeof(*stat)); stat->type = STGTY_STREAM;
        stat->cbSize.QuadPart = source->files[index].size; stat->grfMode = STGM_READ; return S_OK;
    }
    HRESULT STDMETHODCALLTYPE Clone(IStream** out) override {
        if (!out) return E_POINTER;
        *out = new (std::nothrow) Stream(source, index, position);
        return *out ? S_OK : E_OUTOFMEMORY;
    }
};

class DataObject final : public IDataObject {
    std::atomic<ULONG> refs{1};
    std::shared_ptr<Source> source;
    CLIPFORMAT descriptors, contents;
public:
    explicit DataObject(std::shared_ptr<Source> s) : source(std::move(s)),
        descriptors(static_cast<CLIPFORMAT>(RegisterClipboardFormatW(CFSTR_FILEDESCRIPTORW))),
        contents(static_cast<CLIPFORMAT>(RegisterClipboardFormatW(CFSTR_FILECONTENTS))) {}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override {
        if (!out) return E_POINTER; *out = nullptr;
        if (iid == IID_IUnknown || iid == IID_IDataObject) { *out = static_cast<IDataObject*>(this); AddRef(); return S_OK; }
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
    ULONG STDMETHODCALLTYPE Release() override { ULONG n = --refs; if (!n) delete this; return n; }
    HRESULT STDMETHODCALLTYPE QueryGetData(FORMATETC* format) override {
        if (!format) return E_POINTER;
        if (format->dwAspect != DVASPECT_CONTENT || format->ptd) return DV_E_FORMATETC;
        if (format->cfFormat == descriptors && format->lindex == -1 && (format->tymed & TYMED_HGLOBAL)) return S_OK;
        if (format->cfFormat == contents && format->lindex >= 0 && static_cast<size_t>(format->lindex) < source->files.size() && !source->files[format->lindex].directory && (format->tymed & TYMED_ISTREAM)) return S_OK;
        return DV_E_FORMATETC;
    }
    HRESULT STDMETHODCALLTYPE GetData(FORMATETC* format, STGMEDIUM* medium) override {
        if (!medium) return E_POINTER;
        std::memset(medium, 0, sizeof(*medium));
        HRESULT hr = QueryGetData(format); if (FAILED(hr)) return hr;
        if (format->cfFormat == contents) {
            auto* stream = new (std::nothrow) Stream(source, static_cast<size_t>(format->lindex));
            if (!stream) return E_OUTOFMEMORY;
            medium->tymed = TYMED_ISTREAM; medium->pstm = stream; return S_OK;
        }
        const size_t count = source->files.size();
        if (count > ((std::numeric_limits<SIZE_T>::max)() - sizeof(UINT)) / sizeof(FILEDESCRIPTORW)) return E_OUTOFMEMORY;
        HGLOBAL mem = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, sizeof(UINT) + count * sizeof(FILEDESCRIPTORW));
        if (!mem) return E_OUTOFMEMORY;
        auto* group = static_cast<FILEGROUPDESCRIPTORW*>(GlobalLock(mem));
        if (!group) { GlobalFree(mem); return E_OUTOFMEMORY; }
        group->cItems = static_cast<UINT>(count);
        for (size_t i = 0; i < count; ++i) {
            auto& d = group->fgd[i]; const auto& f = source->files[i];
            d.dwFlags = FD_ATTRIBUTES | FD_FILESIZE | FD_PROGRESSUI | FD_UNICODE;
            d.dwFileAttributes = f.directory ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_NORMAL;
            d.nFileSizeHigh = static_cast<DWORD>(f.size >> 32); d.nFileSizeLow = static_cast<DWORD>(f.size);
            std::copy(f.path.begin(), f.path.end(), d.cFileName); d.cFileName[f.path.size()] = L'\0';
        }
        GlobalUnlock(mem); medium->tymed = TYMED_HGLOBAL; medium->hGlobal = mem; return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetDataHere(FORMATETC*, STGMEDIUM*) override { return DATA_E_FORMATETC; }
    HRESULT STDMETHODCALLTYPE GetCanonicalFormatEtc(FORMATETC*, FORMATETC* out) override { if (!out) return E_POINTER; out->ptd = nullptr; return DATA_S_SAMEFORMATETC; }
    HRESULT STDMETHODCALLTYPE SetData(FORMATETC*, STGMEDIUM*, BOOL) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE EnumFormatEtc(DWORD direction, IEnumFORMATETC** out) override {
        if (!out) return E_POINTER; *out = nullptr;
        if (direction != DATADIR_GET) return E_NOTIMPL;
        FORMATETC formats[2] = {{descriptors, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL}, {contents, nullptr, DVASPECT_CONTENT, -1, TYMED_ISTREAM}};
        return SHCreateStdEnumFmtEtc(2, formats, out);
    }
    HRESULT STDMETHODCALLTYPE DAdvise(FORMATETC*, DWORD, IAdviseSink*, DWORD*) override { return OLE_E_ADVISENOTSUPPORTED; }
    HRESULT STDMETHODCALLTYPE DUnadvise(DWORD) override { return OLE_E_ADVISENOTSUPPORTED; }
    HRESULT STDMETHODCALLTYPE EnumDAdvise(IEnumSTATDATA**) override { return OLE_E_ADVISENOTSUPPORTED; }
};
}

HRESULT CreateVirtualFiles(const std::vector<File>& files, Read read, IDataObject** object) {
    if (!object) return E_POINTER; *object = nullptr;
    if (!read || files.empty() || files.size() > UINT_MAX) return E_INVALIDARG;
    for (const auto& f : files) {
        if (f.path.empty() || f.path.size() >= MAX_PATH || f.path.front() == L'\\' || f.path.front() == L'/' || f.path.find(L':') != std::wstring::npos || f.path.find(L'\0') != std::wstring::npos) return E_INVALIDARG;
        size_t start = 0;
        while (start <= f.path.size()) {
            const size_t end = f.path.find_first_of(L"\\/", start);
            auto part = f.path.substr(start, end == std::wstring::npos ? end : end - start);
            if (part.empty() || part == L"." || part == L"..") return E_INVALIDARG;
            if (end == std::wstring::npos) break; start = end + 1;
        }
    }
    try {
        auto source = std::make_shared<Source>(); source->files = files; source->read = std::move(read);
        *object = new (std::nothrow) DataObject(std::move(source));
        return *object ? S_OK : E_OUTOFMEMORY;
    } catch (...) { return E_OUTOFMEMORY; }
}
}
#endif
