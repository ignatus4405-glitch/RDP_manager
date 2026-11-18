; Компонентный NSIS-установщик RDP Manager: клиент, Windows-служба или оба.
; Этот файл подключается electron-builder через build.nsis.include.
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!define RDP_COMPONENTS_KEY "Software\RDP Manager\Components"
!define RDP_SERVICE_ID "RDPManagerServer"
!define RDP_FIREWALL_RULE "RDP Manager Server (TCP 8720)"
!define RDP_SERVER_DATA "$%PROGRAMDATA%\RDP Manager Server"
!define RDP_LEGACY_SERVER "$PROGRAMFILES64\RDP Manager Server"
!define RDP_SERVER_PAYLOAD "${BUILD_RESOURCES_DIR}\server-payload"

Var RdpInstallClient
Var RdpInstallServer
Var RdpRadioClient
Var RdpRadioServer
Var RdpRadioBoth
Var RdpComponentsDialog

!macro customInit
  ; Сохраняем выбор компонентов. Для обновления со старых отдельных установщиков определяем их по файлам.
  StrCpy $RdpInstallClient "0"
  StrCpy $RdpInstallServer "0"
  ReadRegStr $0 HKLM "${RDP_COMPONENTS_KEY}" "ClientInstalled"
  ReadRegStr $1 HKLM "${RDP_COMPONENTS_KEY}" "ServerInstalled"
  ${If} $0 != ""
  ${OrIf} $1 != ""
    StrCpy $RdpInstallClient $0
    StrCpy $RdpInstallServer $1
  ${Else}
    ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      StrCpy $RdpInstallClient "1"
    ${EndIf}
    ${If} ${FileExists} "${RDP_LEGACY_SERVER}\rdp-manager-server.exe"
      StrCpy $RdpInstallServer "1"
    ${EndIf}
    ${If} $RdpInstallClient == "0"
    ${AndIf} $RdpInstallServer == "0"
      StrCpy $RdpInstallClient "1"
    ${EndIf}
  ${EndIf}
!macroend

!macro customHeader
  ; Этот hook вызывается после assistedInstaller.nsh, чтобы страница была зарегистрирована
  ; после выбора папки установки и до начала копирования файлов.
  Page custom RdpComponentsPageCreate RdpComponentsPageLeave
!macroend

Function RdpComponentsPageCreate
  ${If} ${Silent}
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $RdpComponentsDialog
  ${If} $RdpComponentsDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 16u "Выберите компоненты для установки:"
  Pop $0

  ${NSD_CreateRadioButton} 0 22u 100% 12u "Только десктоп-клиент"
  Pop $RdpRadioClient
  ${NSD_CreateLabel} 18u 36u 94% 20u "Подключения сотрудников, встроенный RDP и документация."
  Pop $0

  ${NSD_CreateRadioButton} 0 63u 100% 12u "Серверная служба + графическое управление"
  Pop $RdpRadioServer
  ${NSD_CreateLabel} 18u 77u 94% 34u "Служба Windows с автозапуском и восстановлением после сбоя; окно управления, значок в трее и просмотр логов."
  Pop $0

  ${NSD_CreateRadioButton} 0 119u 100% 12u "Клиент и сервер"
  Pop $RdpRadioBoth
  ${NSD_CreateLabel} 18u 133u 94% 20u "Установить обе части на этот компьютер."
  Pop $0

  ${If} $RdpInstallClient == "1"
  ${AndIf} $RdpInstallServer == "1"
    ${NSD_SetState} $RdpRadioBoth ${BST_CHECKED}
  ${ElseIf} $RdpInstallServer == "1"
    ${NSD_SetState} $RdpRadioServer ${BST_CHECKED}
  ${Else}
    ${NSD_SetState} $RdpRadioClient ${BST_CHECKED}
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function RdpComponentsPageLeave
  ${NSD_GetState} $RdpRadioClient $0
  ${NSD_GetState} $RdpRadioServer $1
  ${NSD_GetState} $RdpRadioBoth $2
  ${If} $0 == ${BST_CHECKED}
    StrCpy $RdpInstallClient "1"
    StrCpy $RdpInstallServer "0"
  ${ElseIf} $1 == ${BST_CHECKED}
    StrCpy $RdpInstallClient "0"
    StrCpy $RdpInstallServer "1"
  ${ElseIf} $2 == ${BST_CHECKED}
    StrCpy $RdpInstallClient "1"
    StrCpy $RdpInstallServer "1"
  ${EndIf}
FunctionEnd

!macro migrateLegacyServer
  ; Убираем старый установщик сервера даже при выборе «только клиент», чтобы не оставить скрытую службу.
  ${If} ${FileExists} "${RDP_LEGACY_SERVER}\rdp-manager-server.exe"
    DetailPrint "Останавливаю старый сервер и переношу его данные…"
    CreateDirectory "${RDP_SERVER_DATA}\data"
    ExecWait 'schtasks /End /TN "RDP Manager Server"' $0
    ExecWait 'schtasks /Delete /TN "RDP Manager Server" /F' $0
    ExecWait 'taskkill /F /IM rdp-manager-server.exe' $0
    Sleep 1200
    ${IfNot} ${FileExists} "${RDP_SERVER_DATA}\data\rdp-manager.db"
      ${If} ${FileExists} "${RDP_LEGACY_SERVER}\data\rdp-manager.db"
        ClearErrors
        CopyFiles /SILENT "${RDP_LEGACY_SERVER}\data\*.*" "${RDP_SERVER_DATA}\data"
        ${If} ${Errors}
          MessageBox MB_ICONSTOP "Не удалось перенести базу и ключ старого сервера. Старые данные сохранены в Program Files; исправьте доступ и повторите установку."
          Abort
        ${EndIf}
        ${IfNot} ${FileExists} "${RDP_SERVER_DATA}\data\rdp-manager.db"
          MessageBox MB_ICONSTOP "После переноса не найдена база старого сервера. Старые данные сохранены; повторите установку."
          Abort
        ${EndIf}
      ${EndIf}
    ${EndIf}
    Delete "${RDP_LEGACY_SERVER}\rdp-manager-server.exe"
    Delete "${RDP_LEGACY_SERVER}\panel.url"
    Delete "${RDP_LEGACY_SERVER}\Uninstall.exe"
    RMDir /r "${RDP_LEGACY_SERVER}\web"
    RMDir /r "$SMPROGRAMS\RDP Manager Server"
    RMDir "${RDP_LEGACY_SERVER}"
    DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\RDPManagerServer"
  ${EndIf}
!macroend

!macro customInstall
  ; Переносим старую самостоятельную Windows-установку перед применением выбора компонентов.
  !insertmacro migrateLegacyServer
  ; electron-builder уже распаковал приложение. Добавляем серверный комплект только по выбору пользователя.
  ${If} $RdpInstallServer == "1"
    SetOutPath "$INSTDIR\server"
    File "${RDP_SERVER_PAYLOAD}\rdp-manager-server.exe"
    File "${RDP_SERVER_PAYLOAD}\RDPManagerServer.exe"
    File "${RDP_SERVER_PAYLOAD}\RDPManagerServer.xml"
    File "${RDP_SERVER_PAYLOAD}\WinSW-LICENSE.txt"
    File "${RDP_SERVER_PAYLOAD}\server-version.txt"
    SetOutPath "$INSTDIR\server\web"
    File /r "${RDP_SERVER_PAYLOAD}\web\*.*"

    CreateDirectory "${RDP_SERVER_DATA}\data"
    CreateDirectory "${RDP_SERVER_DATA}\logs"

    ; Стандартные пользователи могут просматривать логи в GUI; каталог данных остаётся закрытым.
    ExecWait '"$SYSDIR\icacls.exe" "${RDP_SERVER_DATA}\logs" /grant "*S-1-5-32-545:(OI)(CI)RX" /T /C' $0

    ; WinSW регистрирует настоящий Windows Service. Приложение пишет server.log, WinSW ротирует stdout/stderr.
    ExecWait '"$INSTDIR\server\RDPManagerServer.exe" install' $0
    ${If} $0 != 0
      MessageBox MB_ICONSTOP "Не удалось зарегистрировать службу RDP Manager Server (код $0). Установка будет остановлена. Запустите установщик от имени администратора."
      Abort
    ${EndIf}
    ExecWait 'netsh advfirewall firewall delete rule name="${RDP_FIREWALL_RULE}"' $0
    ExecWait 'netsh advfirewall firewall add rule name="${RDP_FIREWALL_RULE}" dir=in action=allow protocol=TCP localport=8720' $0
    ExecWait '"$INSTDIR\server\RDPManagerServer.exe" start' $0
    ${If} $0 != 0
      MessageBox MB_ICONEXCLAMATION "Служба установлена, но не запустилась (код $0). Откройте управление сервером и проверьте журнал."
    ${EndIf}
  ${Else}
    ; Если серверный компонент сняли при обновлении, старый uninstaller уже удалил службу.
    ExecWait 'netsh advfirewall firewall delete rule name="${RDP_FIREWALL_RULE}"' $0
  ${EndIf}

  WriteRegStr HKLM "${RDP_COMPONENTS_KEY}" "ClientInstalled" "$RdpInstallClient"
  WriteRegStr HKLM "${RDP_COMPONENTS_KEY}" "ServerInstalled" "$RdpInstallServer"
  ${If} $RdpInstallServer == "1"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "RDPManagerServerManager" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" --server-manager --server-manager-tray"
  ${Else}
    DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "RDPManagerServerManager"
  ${EndIf}

  ; Собственные ярлыки условны: серверный ярлык запускает отдельное окно управления.
  SetShellVarContext all
  Delete "$SMPROGRAMS\RDP Manager.lnk"
  Delete "$SMPROGRAMS\RDP Manager\RDP Manager.lnk"
  CreateDirectory "$SMPROGRAMS\RDP Manager"
  ${If} $RdpInstallClient == "1"
    CreateShortCut "$SMPROGRAMS\RDP Manager\RDP Manager.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  ${Else}
    Delete "$SMPROGRAMS\RDP Manager\RDP Manager.lnk"
  ${EndIf}
  ${If} $RdpInstallServer == "1"
    CreateShortCut "$SMPROGRAMS\RDP Manager\Управление сервером.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--server-manager" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  ${Else}
    Delete "$SMPROGRAMS\RDP Manager\Управление сервером.lnk"
  ${EndIf}
  CreateShortCut "$SMPROGRAMS\RDP Manager\Удалить RDP Manager.lnk" "$INSTDIR\${UNINSTALL_FILENAME}"
!macroend

!macro customUnInstall
  ; При обновлении NSIS вызывает этот макрос в тихом режиме: служба переустанавливается ниже,
  ; ProgramData не трогаем. При обычном удалении оставляем базу и логи по умолчанию.
  ${If} ${FileExists} "$INSTDIR\server\RDPManagerServer.exe"
    ExecWait '"$INSTDIR\server\RDPManagerServer.exe" stop' $0
    ExecWait '"$INSTDIR\server\RDPManagerServer.exe" uninstall' $0
  ${EndIf}
  ExecWait 'netsh advfirewall firewall delete rule name="${RDP_FIREWALL_RULE}"' $0

  SetShellVarContext all
  Delete "$SMPROGRAMS\RDP Manager.lnk"
  RMDir /r "$SMPROGRAMS\RDP Manager"
  DeleteRegKey HKLM "${RDP_COMPONENTS_KEY}"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "RDPManagerServerManager"

  ${IfNot} ${Silent}
    ${If} ${FileExists} "${RDP_SERVER_DATA}\data\rdp-manager.db"
    ${OrIf} ${FileExists} "${RDP_SERVER_DATA}\logs\server.log"
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Удалить базу данных сервера и логи из %ProgramData%?$\r$\n$\r$\nНет — сохранить (рекомендуется)." IDNO rdp_keep_server_data
        RMDir /r "${RDP_SERVER_DATA}"
      rdp_keep_server_data:
    ${EndIf}
  ${EndIf}
!macroend
