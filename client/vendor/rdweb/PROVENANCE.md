# rdweb upstream

Vendored from https://github.com/bropines/rdweb at commit
`6d67e8d89b82c03df60df1adfa5207a0d5802c25` (package version 0.11.1).
MIT licensed; see LICENSE and NOTICE. The integration imports only Session and
Viewer. The vendored source has not been independently security audited.

Local change: ViewerOptions.handleRemoteClipboard permits the application to own clipboard synchronization.
Local change: opt-in encrypted RustDesk Cliprdr wire forwarding for desktop file clipboard.
