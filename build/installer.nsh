; Keep the application-specific name in sync with platform/autostart.ts.
!macro customUnInstall
  ; An update runs the previous uninstaller: keep login preferences on upgrade.
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.deepseek.whalepet"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.deepseek.whalepet"
  ${endIf}
!macroend
