'use strict';

// ---------------------------------------------------------------------------
// Raw printer output
//
// Hands a buffer of bytes to a Windows printer queue using the spooler's RAW
// data type. The bytes go to the printer untouched, which is what makes a
// thermal receipt printer work even when its Windows driver cannot drive it —
// for example Epson's Advanced Printer Driver bound to a generic
// USB-to-parallel cable, which spools a job and then reports "0 bytes printed".
//
// Plain Node cannot reach the spooler API, so the call is made through a short
// PowerShell helper that P/Invokes winspool's WritePrinter. The helper is passed
// with -EncodedCommand, so there is no script file to unpack from the app bundle
// and nothing is left on disk (only the receipt is staged, briefly, in TEMP).
// ---------------------------------------------------------------------------

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The document name is used to recognise our own job in the queue afterwards.
const DOCUMENT_NAME = 'Immaculate POS Receipt';

const CS_HELPER = `
using System;
using System.Runtime.InteropServices;

public class RawPrinterHelper
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public class DOCINFOA
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }

    [DllImport("winspool.Drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
    public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);

    [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

    public static int SendFile(string printerName, string filePath)
    {
        byte[] bytes = System.IO.File.ReadAllBytes(filePath);
        IntPtr hPrinter;
        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
            return -1;
        int written = 0;
        DOCINFOA di = new DOCINFOA();
        di.pDocName = "Immaculate POS Receipt";
        di.pDataType = "RAW";
        if (StartDocPrinter(hPrinter, 1, di))
        {
            if (StartPagePrinter(hPrinter))
            {
                IntPtr buf = Marshal.AllocCoTaskMem(bytes.Length);
                Marshal.Copy(bytes, 0, buf, bytes.Length);
                WritePrinter(hPrinter, buf, bytes.Length, out written);
                Marshal.FreeCoTaskMem(buf);
                EndPagePrinter(hPrinter);
            }
            EndDocPrinter(hPrinter);
        }
        ClosePrinter(hPrinter);
        return written;
    }
}
`;

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function buildScript(printerName, filePath) {
  // Anything the helper wants to say is written to stdout behind a marker and
  // parsed in one piece. Letting PowerShell report a failure on stderr instead
  // would hand back a CLIXML blob rather than a sentence a cashier can read.
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "$signature = @'",
    CS_HELPER,
    "'@",
    'try {',
    '  Add-Type -TypeDefinition $signature | Out-Null',
    '  $printer = ' + psQuote(printerName),
    '  $file = ' + psQuote(filePath),
    '  $docName = ' + psQuote(DOCUMENT_NAME),
    // Get-PrintJob lives in the PrintManagement module, which is not on every
    // Windows install. Without it we can only report what the spooler accepted,
    // which is exactly the situation this polling exists to avoid.
    '  $canCheckQueue = $null -ne (Get-Command Get-PrintJob -ErrorAction SilentlyContinue)',
    '  if ($canCheckQueue) {',
    // A receipt left behind by an earlier stalled attempt would sit in front of
    // this one forever, so clear anything already wedged on the printer.
    '    Get-PrintJob -PrinterName $printer -ErrorAction SilentlyContinue |',
    "      Where-Object { $_.JobStatus -match 'Printing|Deleting|Error' } |",
    '      Remove-PrintJob -ErrorAction SilentlyContinue',
    '  }',
    '  $expected = (Get-Item -LiteralPath $file).Length',
    '  $written = [RawPrinterHelper]::SendFile($printer, $file)',
    '  if ($written -lt 0) { throw "Could not open printer \'" + $printer + "\'. Is it installed, switched on and not paused?" }',
    '  if ($written -ne $expected) { throw "Only " + $written + " of " + $expected + " bytes reached \'" + $printer + "\'." }',
    // The spooler accepting the bytes says nothing about the printer having
    // taken them: a printer that has stopped responding leaves the job sitting
    // in the queue, and every later receipt queues up behind it. Wait for our
    // job to clear, and if it never does, drop it so the till stays usable and
    // say so, rather than reporting a receipt that never came out.
    '  if ($canCheckQueue) {',
    '    $deadline = (Get-Date).AddSeconds(8)',
    '    $stuck = @()',
    '    while ($true) {',
    '      Start-Sleep -Milliseconds 500',
    '      $stuck = @(Get-PrintJob -PrinterName $printer -ErrorAction SilentlyContinue |',
    '                 Where-Object { $_.DocumentName -eq $docName })',
    '      if ($stuck.Count -eq 0) { break }',
    '      if ((Get-Date) -gt $deadline) {',
    '        $stuck | Remove-PrintJob -ErrorAction SilentlyContinue',
    '        throw "The printer did not take the receipt. Check it is switched on, has paper, has no error light, and that its cable is firmly plugged in, then print it again."',
    '      }',
    '    }',
    '  }',
    '  Write-Output ("OK:" + $written)',
    '} catch {',
    '  Write-Output ("ERR:" + $_.Exception.Message)',
    '  exit 1',
    '}'
  ].join('\r\n');
}

// Resolves to { ok: true, bytesWritten } or { ok: false, error }.
function sendRawToPrinter(printerName, data, timeoutMs) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, error: 'Printing straight to a thermal printer is only supported on Windows.' });
      return;
    }
    if (!printerName) {
      resolve({ ok: false, error: 'No receipt printer selected.' });
      return;
    }

    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data || []);

    let tmpFile;
    try {
      tmpFile = path.join(os.tmpdir(), 'immaculate-receipt-' + process.pid + '-' + Date.now() + '.prn');
      fs.writeFileSync(tmpFile, buffer);
    } catch (err) {
      resolve({ ok: false, error: 'Could not stage the receipt: ' + err.message });
      return;
    }

    const encoded = Buffer.from(buildScript(printerName, tmpFile), 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true });

    let stdout = '';
    let settled = false;

    function finish(result) {
      if (settled) return;
      settled = true;
      try { fs.unlinkSync(tmpFile); } catch (err) { /* best effort */ }
      resolve(result);
    }

    const limit = Number.isFinite(timeoutMs) ? timeoutMs : 20000;
    const timer = setTimeout(() => {
      try { child.kill(); } catch (err) { /* ignore */ }
      finish({ ok: false, error: 'The printer did not respond within ' + Math.round(limit / 1000) + ' seconds.' });
    }, limit);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: 'Could not start the print helper: ' + err.message });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const okLine = lines.filter((l) => l.startsWith('OK:')).pop();
      const errLine = lines.filter((l) => l.startsWith('ERR:')).pop();

      if (code === 0 && okLine) {
        const written = parseInt(okLine.slice(3), 10);
        finish({ ok: true, bytesWritten: Number.isFinite(written) ? written : buffer.length });
        return;
      }
      if (errLine) {
        finish({ ok: false, error: errLine.slice(4) });
        return;
      }
      finish({ ok: false, error: 'The print helper failed (exit code ' + code + ').' });
    });
  });
}

module.exports = { sendRawToPrinter };
