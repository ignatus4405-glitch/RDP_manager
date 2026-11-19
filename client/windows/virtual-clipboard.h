#pragma once

#ifdef _WIN32
#include <windows.h>
#include <objidl.h>
#include <functional>
#include <string>
#include <vector>

namespace rdp_clipboard {
// Windows relative paths, in FILEGROUPDESCRIPTOR order. Lifetime of the
// callback and source data must extend until all clipboard streams are released.
struct File {
    std::wstring path;
    unsigned long long size;
    bool directory;
};
using Read = std::function<HRESULT(size_t index, unsigned long long offset,
                                   void* data, ULONG requested, ULONG* received)>;
// Construct a COM data object exposing CFSTR_FILEDESCRIPTORW and
// CFSTR_FILECONTENTS as IStream. Caller owns the returned reference. The
// caller is responsible for the OLE apartment and clipboard ownership.
HRESULT CreateVirtualFiles(const std::vector<File>& files, Read read, IDataObject** object);
}
#endif
