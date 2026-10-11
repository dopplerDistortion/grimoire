# Spike D (GOK-129): print owner, DACL and integrity label of a named pipe as SDDL.
# Opens the pipe as a client with READ_CONTROL only, then reads its security descriptor.
param([Parameter(Mandatory = $true)][string]$PipePath)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PipeSd {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetKernelObjectSecurity(IntPtr h, uint info, byte[] sd, uint len, out uint needed);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(byte[] sd, uint rev, uint info, out IntPtr str, out uint len);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  public static string Sddl(string path, uint info) {
    const uint READ_CONTROL = 0x00020000, OPEN_EXISTING = 3;
    IntPtr h = CreateFileW(path, READ_CONTROL, 0, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
    if (h == new IntPtr(-1)) return "OPEN ERROR " + Marshal.GetLastWin32Error();
    try {
      uint needed;
      GetKernelObjectSecurity(h, info, null, 0, out needed);
      byte[] sd = new byte[needed];
      if (!GetKernelObjectSecurity(h, info, sd, needed, out needed)) return "GET ERROR " + Marshal.GetLastWin32Error();
      IntPtr str; uint len;
      if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, 1, info, out str, out len)) return "CONVERT ERROR " + Marshal.GetLastWin32Error();
      string r = Marshal.PtrToStringUni(str); LocalFree(str); return r;
    } finally { CloseHandle(h); }
  }
}
"@
# OWNER (0x1) | GROUP (0x2) | DACL (0x4) | LABEL (0x10)
"SDDL: " + [PipeSd]::Sddl($PipePath, 0x17)
$id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$elevated = (New-Object System.Security.Principal.WindowsPrincipal($id)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
"current user SID: " + $id.User.Value + " | elevated admin: " + $elevated
"logon SID: " + (($id.Groups | Where-Object { $_.Value -like 'S-1-5-5-*' }) -join ',')
