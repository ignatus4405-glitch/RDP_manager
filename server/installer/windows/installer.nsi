; ============================================================
;  RDP Manager Server — установщик для Windows (NSIS)
;  Собирается в CI: makensis /DVERSION=1.2.0 installer.nsi
;  Ожидает в своей папке:
;    rdp-manager-server.exe  — однофайловый SEA-бинарь сервера
;    web/                    — веб-панель администратора
; ============================================================
Unicode true
!include "MUI2.nsh"

!ifndef VERSION
  !define VERSION "1.2.0"
!endif
!define APP_NAME   "RDP Manager Server"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\RDPManagerServer"
!define TASK_NAME  "RDP Manager Server"
!define FW_RULE    "RDP Manager Server (TCP 8720)"

Name "${APP_NAME}"
OutFile "RDPManager-Server-Setup-${VERSION}.exe"
InstallDir "$PROGRAMFILES64\RDP Manager Server"
RequestExecutionLevel admin
SetCompressor /SOLID lzma

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TEXT "${APP_NAME} установлен и запущен.$\r$\n$\r$\nПанель администратора: http://localhost:8720/$\r$\nВеб-клиент: http://<IP-сервера>:8720/app/$\r$\nПервый вход: admin / admin123 (смена пароля обязательна).$\r$\n$\r$\nСервер стартует автоматически при загрузке Windows (как SYSTEM)."
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Russian"
!insertmacro MUI_LANGUAGE "English"

Section "Установка" SEC_INSTALL
  SetOutPath "$INSTDIR"
  File "rdp-manager-server.exe"
  File /r "web"
  CreateDirectory "$INSTDIR\data"

  ; Ярлык «Панель сервера» (.url) + папка в меню «Пуск»
  FileOpen $0 "$INSTDIR\panel.url" w
  FileWrite $0 "[InternetShortcut]$\r$\nURL=http://localhost:8720/$\r$\nIconIndex=0$\r$\n"
  FileClose $0
  CreateDirectory "$SMPROGRAMS\RDP Manager Server"
  CreateShortCut "$SMPROGRAMS\RDP Manager Server\Панель сервера.lnk" "$INSTDIR\panel.url"
  CreateShortCut "$SMPROGRAMS\RDP Manager Server\Удалить RDP Manager Server.lnk" "$INSTDIR\Uninstall.exe"

  ; Автозапуск при загрузке Windows от SYSTEM + немедленный старт
  ExecWait 'schtasks /Create /TN "${TASK_NAME}" /TR "\"$INSTDIR\rdp-manager-server.exe\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /F'
  ExecWait 'schtasks /Run /TN "${TASK_NAME}"'

  ; Правило брандмауэра — входящие TCP 8720
  ExecWait 'netsh advfirewall firewall add rule name="${FW_RULE}" dir=in action=allow protocol=TCP localport=8720'

  ; Запись в «Установка и удаление программ»
  WriteRegStr   HKLM "${UNINST_KEY}" "DisplayName"     "${APP_NAME}"
  WriteRegStr   HKLM "${UNINST_KEY}" "DisplayVersion"  "${VERSION}"
  WriteRegStr   HKLM "${UNINST_KEY}" "Publisher"       "RDP Manager"
  WriteRegStr   HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr   HKLM "${UNINST_KEY}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1

  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  ; Остановить и удалить задачу автозапуска
  ExecWait 'schtasks /End /TN "${TASK_NAME}"'
  ExecWait 'schtasks /Delete /TN "${TASK_NAME}" /F'
  ; Убрать правило брандмауэра
  ExecWait 'netsh advfirewall firewall delete rule name="${FW_RULE}"'

  ; Спросить про базу данных
  MessageBox MB_YESNO|MB_ICONQUESTION "Удалить базу данных подключений и документов?$\r$\n$\r$\nНет — оставить (рекомендуется)." IDNO skip_data
    RMDir /r "$INSTDIR\data"
  skip_data:

  Delete "$INSTDIR\rdp-manager-server.exe"
  Delete "$INSTDIR\panel.url"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR\web"
  RMDir /r "$SMPROGRAMS\RDP Manager Server"
  RMDir "$INSTDIR"   ; удалится только если пустой (т.е. без data — если пользователь решил оставить)
  DeleteRegKey HKLM "${UNINST_KEY}"
SectionEnd
