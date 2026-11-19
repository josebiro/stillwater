Unicode true
Name "Stillwater"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\Stillwater"
InstallDirRegKey HKCU "Software\Stillwater" "InstallDirectory"
RequestExecutionLevel user
SetCompressor zlib
!include "MUI2.nsh"
!include "x64.nsh"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Stillwater"
  SetShellVarContext current
  IfFileExists "$EXEDIR\Stillwater-CUDA-x64.zip" cuda_present
  SetErrorLevel 2
  MessageBox MB_ICONSTOP "Keep Stillwater-CUDA-x64.zip beside the installer." /SD IDOK
  Abort
cuda_present:
  ${DisableX64FSRedirection}
  IfFileExists "$SYSDIR\msvcp140.dll" 0 runtime_missing
  IfFileExists "$SYSDIR\msvcp140_1.dll" runtime_present
runtime_missing:
  ${EnableX64FSRedirection}
  SetErrorLevel 4
  MessageBox MB_ICONSTOP "Install the Microsoft Visual C++ v14 Redistributable (x64), then run Stillwater Setup again." /SD IDOK
  Abort
runtime_present:
  ${EnableX64FSRedirection}
  IfFileExists "$INSTDIR\Stillwater.exe" 0 executable_ready
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\Stillwater.exe", i 0x40000000, i 7, p 0, i 3, i 128, p 0) p .r0'
  StrCmp $0 -1 executable_locked
  System::Call 'kernel32::CloseHandle(p r0)'
  Goto executable_ready
executable_locked:
  SetErrorLevel 5
  MessageBox MB_ICONSTOP "Setup could not open the existing Stillwater executable for replacement. Quit Stillwater completely and retry. If the problem persists, check write access to the installation folder." /SD IDOK
  Abort
executable_ready:
  SetOutPath "$INSTDIR"
  File /r /x nvidia "${PAYLOAD}\*"
  ${DisableX64FSRedirection}
  ExecWait '"$SYSDIR\tar.exe" -xf "$EXEDIR\Stillwater-CUDA-x64.zip" -C "$INSTDIR\resources\app\python\Lib\site-packages"' $0
  ${EnableX64FSRedirection}
  StrCmp $0 0 cuda_extracted
  SetErrorLevel 3
  MessageBox MB_ICONSTOP "Could not extract the bundled CUDA libraries." /SD IDOK
  Abort
cuda_extracted:
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Stillwater"
  CreateShortcut "$SMPROGRAMS\Stillwater\Stillwater.lnk" "$INSTDIR\Stillwater.exe"
  WriteRegStr HKCU "Software\Stillwater" "InstallDirectory" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Stillwater" "DisplayName" "Stillwater"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Stillwater" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Stillwater" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Stillwater" "DisplayIcon" "$INSTDIR\Stillwater.exe"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Stillwater" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Stillwater" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  !include "${REMOVE_LIST}"
  Delete "$INSTDIR\Uninstall.exe"
  Delete "$SMPROGRAMS\Stillwater\Stillwater.lnk"
  RMDir "$SMPROGRAMS\Stillwater"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Stillwater"
  DeleteRegKey HKCU "Software\Stillwater"
  RMDir "$INSTDIR"
SectionEnd
