; Компонентный NSIS-установщик RDP Manager: клиент, Windows-служба или оба.
; Этот файл подключается electron-builder через build.nsis.include.
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "StrFunc.nsh"
!ifndef BUILD_UNINSTALLER
${StrStr}
!endif

!define RDP_COMPONENTS_KEY "Software\RDP Manager\Components"
!define RDP_SERVICE_ID "RDPManagerServer"
!define RDP_FIREWALL_RULE "RDP Manager Server (TCP 8720)"
!define RDP_SERVER_DATA "$%PROGRAMDATA%\RDP Manager Server"
!define RDP_SERVER_DB "${RDP_SERVER_DATA}\data"
!define RDP_LEGACY_SERVER "$PROGRAMFILES64\RDP Manager Server"
!define RDP_SERVER_PAYLOAD "${BUILD_RESOURCES_DIR}\server-payload"

Var RdpDataDirectory
!ifndef BUILD_UNINSTALLER
Var RdpInstallClient
Var RdpInstallServer
Var RdpRadioClient
Var RdpRadioServer
Var RdpRadioBoth
Var RdpComponentsDialog
Var RdpPreviousDataDirectory
Var RdpDataDirectoryInput
Var RdpBrowseDataButton
!endif

!macro customInit
  ; Сохраняем выбор компонентов. Для обновления со старых отдельных установщиков определяем их по файлам.
  StrCpy $RdpInstallClient "0"
  StrCpy $RdpInstallServer "0"
  ReadRegStr $RdpDataDirectory HKLM "${RDP_COMPONENTS_KEY}" "ServerDataDir"
  ${If} $RdpDataDirectory == ""
    StrCpy $RdpDataDirectory "${RDP_SERVER_DB}"
  ${EndIf}
  StrCpy $RdpPreviousDataDirectory "$RdpDataDirectory"
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

!macro customPageAfterChangeDir
  ; Экран выбора компонентов и каталога базы должен предшествовать распаковке/установке файлов.
  Page custom RdpComponentsPageCreate RdpComponentsPageLeave
!macroend

!ifndef BUILD_UNINSTALLER
Function RdpComponentsPageCreate
  ${If} ${Silent}
    Abort
  ${EndIf}
  ; Страница наследует MUI-заголовок предыдущего шага; задаём свой текст.
  GetDlgItem $0 $HWNDPARENT 1037
  SendMessage $0 0x000C 0 "STR:Компоненты и данные сервера"
  GetDlgItem $0 $HWNDPARENT 1038
  SendMessage $0 0x000C 0 "STR:Выберите состав установки и папку базы данных."
  nsDialogs::Create 1018
  Pop $RdpComponentsDialog
  ${If} $RdpComponentsDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 16u "Выберите компоненты для установки:"
  Pop $0

  ${NSD_CreateRadioButton} 0 18u 100% 12u "Только десктоп-клиент"
  Pop $RdpRadioClient

  ${NSD_CreateRadioButton} 0 36u 100% 12u "Серверная служба + графическое управление"
  Pop $RdpRadioServer

  ${NSD_CreateRadioButton} 0 54u 100% 12u "Клиент и сервер"
  Pop $RdpRadioBoth

  ${NSD_CreateLabel} 0 76u 100% 12u "Папка базы и ключа сервера:"
  Pop $0
  ${NSD_CreateText} 0 91u 75% 14u ""
  Pop $RdpDataDirectoryInput
  ${NSD_SetText} $RdpDataDirectoryInput "$RdpDataDirectory"
  ${NSD_CreateButton} 77% 91u 23% 14u "Обзор…"
  Pop $RdpBrowseDataButton
  ${NSD_OnClick} $RdpBrowseDataButton RdpBrowseForDataDirectory
  ${NSD_CreateLabel} 0 112u 100% 12u "Журналы сервера остаются в ProgramData."
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

Function RdpBrowseForDataDirectory
  ${NSD_GetText} $RdpDataDirectoryInput $RdpDataDirectory
  nsDialogs::SelectFolderDialog "Выберите папку базы данных сервера" "$RdpDataDirectory"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $RdpDataDirectoryInput "$0"
  ${EndIf}
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

  ${NSD_GetText} $RdpDataDirectoryInput $RdpDataDirectory
  ${If} $RdpInstallServer == "1"
    ${If} $RdpDataDirectory == ""
      MessageBox MB_ICONSTOP "Укажите папку для базы и ключа серверной части."
      Abort
    ${EndIf}
    ; Только абсолютные пути на дисках; корень диска не подходит.
    StrCpy $0 $RdpDataDirectory 1 1
    StrCpy $1 $RdpDataDirectory 1 2
    ${If} $0 != ":"
    ${OrIf} $1 != "\"
      MessageBox MB_ICONSTOP "Выберите абсолютный путь на локальном диске."
      Abort
    ${EndIf}
    GetFullPathName $RdpDataDirectory "$RdpDataDirectory"
    StrLen $0 $RdpDataDirectory
    ${If} $0 <= 3
      MessageBox MB_ICONSTOP "Выберите отдельную папку, а не корень диска."
      Abort
    ${EndIf}
    ${StrStr} $0 "$RdpDataDirectory" "%"
    ${If} $0 != ""
      MessageBox MB_ICONSTOP "Путь не должен содержать знак процента (%). Выберите другую папку."
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

!endif

!macro migrateLegacyServer
  ; Убираем старый установщик сервера даже при выборе «только клиент», чтобы не оставить скрытую службу.
  ${If} ${FileExists} "${RDP_LEGACY_SERVER}\rdp-manager-server.exe"
    DetailPrint "Останавливаю старый сервер и переношу его данные…"
    ${If} $RdpInstallServer == "1"
      StrCpy $1 "$RdpDataDirectory"
    ${Else}
      StrCpy $1 "$RdpPreviousDataDirectory"
    ${EndIf}
    CreateDirectory "$1"
    ExecWait 'schtasks /End /TN "RDP Manager Server"' $0
    ExecWait 'schtasks /Delete /TN "RDP Manager Server" /F' $0
    ExecWait 'taskkill /F /IM rdp-manager-server.exe' $0
    Sleep 1200
    ${IfNot} ${FileExists} "$1\rdp-manager.db"
      ${If} ${FileExists} "${RDP_LEGACY_SERVER}\data\rdp-manager.db"
        ClearErrors
        CopyFiles /SILENT "${RDP_LEGACY_SERVER}\data\*.*" "$1"
        ${If} ${Errors}
          MessageBox MB_ICONSTOP "Не удалось перенести базу и ключ старого сервера. Старые данные сохранены в Program Files; исправьте доступ и повторите установку."
          Abort
        ${EndIf}
        ${IfNot} ${FileExists} "$1\rdp-manager.db"
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
    ; The previous uninstaller may have left the service registered. Stop it
    ; before replacing the wrapper/server and refuse an unrelated service name.
    InitPluginsDir
    File /oname=$PLUGINSDIR\prepare-server-service.ps1 "${BUILD_RESOURCES_DIR}\prepare-server-service.ps1"
    File /oname=$PLUGINSDIR\register-server-service.ps1 "${BUILD_RESOURCES_DIR}\register-server-service.ps1"
    System::Call 'kernel32::SetEnvironmentVariableW(w "RDP_INSTALL_DIR", w "$INSTDIR") i .r0'
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\prepare-server-service.ps1"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      MessageBox MB_ICONSTOP "Не удалось безопасно остановить службу RDP Manager Server (код $0). Закройте консоль служб и повторите установку.$\r$\n$\r$\nПодробности: $1"
      Abort
    ${EndIf}
    SetOutPath "$INSTDIR\server"
    File "${RDP_SERVER_PAYLOAD}\rdp-manager-server.exe"
    File "${RDP_SERVER_PAYLOAD}\RDPManagerServer.exe"
    File "${RDP_SERVER_PAYLOAD}\RDPManagerServer.xml"
    File "${BUILD_RESOURCES_DIR}\configure-server-data.ps1"
    File "${RDP_SERVER_PAYLOAD}\WinSW-LICENSE.txt"
    File "${RDP_SERVER_PAYLOAD}\server-version.txt"
    SetOutPath "$INSTDIR\server\web"
    File /r "${RDP_SERVER_PAYLOAD}\web\*.*"

    ; Данные старой установки сохраняются независимо от регистрации службы.
    ; Копируем, но не удаляем исходные данные, чтобы восстановление было возможным.
    ${If} $RdpPreviousDataDirectory != $RdpDataDirectory
    ${AndIf} ${FileExists} "$RdpPreviousDataDirectory\rdp-manager.db"
      ${If} ${FileExists} "$RdpDataDirectory\rdp-manager.db"
        MessageBox MB_ICONSTOP "В выбранной папке уже есть база. Выберите пустую папку, чтобы не потерять существующие данные."
        Abort
      ${EndIf}
      CreateDirectory "$RdpDataDirectory"
      ClearErrors
      CopyFiles /SILENT "$RdpPreviousDataDirectory\*.*" "$RdpDataDirectory"
      ${If} ${Errors}
        MessageBox MB_ICONSTOP "Не удалось скопировать данные сервера. Исходные файлы сохранены."
        Abort
      ${EndIf}
      ${IfNot} ${FileExists} "$RdpDataDirectory\rdp-manager.db"
        MessageBox MB_ICONSTOP "Не удалось проверить копию базы. Исходные файлы сохранены."
        Abort
      ${EndIf}
    ${EndIf}
    CreateDirectory "$RdpDataDirectory"
    ${IfNot} ${FileExists} "$RdpDataDirectory\."
      MessageBox MB_ICONSTOP "Не удалось создать папку базы данных."
      Abort
    ${EndIf}
    CreateDirectory "${RDP_SERVER_DATA}\logs"

    ; Передаём путь через переменные процесса, а XML сериализует PowerShell (без подстановки в командную строку).
    System::Call 'kernel32::SetEnvironmentVariableW(w "RDP_INSTALL_DATA", w "$RdpDataDirectory") i .r0'
    System::Call 'kernel32::SetEnvironmentVariableW(w "RDP_INSTALL_XML", w "$INSTDIR\server\RDPManagerServer.xml") i .r0'
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\server\configure-server-data.ps1"'
    Pop $0
    ${If} $0 != 0
      MessageBox MB_ICONSTOP "Не удалось настроить путь базы для службы (код $0)."
      Abort
    ${EndIf}

    ; Стандартные пользователи могут просматривать логи в GUI. Права папки базы наследуются.
    ExecWait '"$SYSDIR\icacls.exe" "${RDP_SERVER_DATA}\logs" /grant "*S-1-5-32-545:(OI)(CI)RX" /T /C' $0

    ; WinSW регистрирует настоящий Windows Service. Приложение пишет server.log, WinSW ротирует stdout/stderr.
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\register-server-service.ps1"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      MessageBox MB_ICONSTOP "Не удалось зарегистрировать службу RDP Manager Server (код $0). Закройте консоль служб и повторите установку.$\r$\n$\r$\nПодробности: $1"
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
    WriteRegStr HKLM "${RDP_COMPONENTS_KEY}" "ServerDataDir" "$RdpDataDirectory"
  ${Else}
    WriteRegStr HKLM "${RDP_COMPONENTS_KEY}" "ServerDataDir" "$RdpPreviousDataDirectory"
  ${EndIf}
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
  ReadRegStr $RdpDataDirectory HKLM "${RDP_COMPONENTS_KEY}" "ServerDataDir"
  ${If} $RdpDataDirectory == ""
    StrCpy $RdpDataDirectory "${RDP_SERVER_DB}"
  ${EndIf}
  ${IfNot} ${isUpdated}
    DeleteRegValue HKLM "${RDP_COMPONENTS_KEY}" "ClientInstalled"
    DeleteRegValue HKLM "${RDP_COMPONENTS_KEY}" "ServerInstalled"
  ${EndIf}
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "RDPManagerServerManager"

  ${IfNot} ${Silent}
    ${If} ${FileExists} "$RdpDataDirectory\rdp-manager.db"
    ${OrIf} ${FileExists} "${RDP_SERVER_DATA}\logs\server.log"
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Удалить файлы базы из $RdpDataDirectory и журналы сервера?$\r$\n$\r$\nНет — сохранить (рекомендуется)." IDNO rdp_keep_server_data
        ; Никогда не удаляем выбранный пользователем каталог целиком.
        Delete "$RdpDataDirectory\rdp-manager.db"
        Delete "$RdpDataDirectory\rdp-manager.db-wal"
        Delete "$RdpDataDirectory\rdp-manager.db-shm"
        Delete "$RdpDataDirectory\secret.key"
        RMDir /r "${RDP_SERVER_DATA}\logs"
        RMDir "$RdpDataDirectory"
        DeleteRegValue HKLM "${RDP_COMPONENTS_KEY}" "ServerDataDir"
      rdp_keep_server_data:
    ${EndIf}
  ${EndIf}
!macroend
