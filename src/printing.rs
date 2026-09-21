//! Listing printers, and sending a receipt straight to one of them.
//!
//! A receipt leaves this app as raw ESC/POS bytes written to the printer's
//! spooler queue. That is the whole point: the printer's own driver is never
//! involved, so this works with printers whose driver cannot actually drive them
//! — a USB-to-parallel adapter cable under Epson's Advanced Printer Driver is the
//! usual culprit, where the job is accepted and then nothing comes out.
//!
//! All that matters is that the printer exists as a queue the system can see;
//! which driver is attached to it makes no difference.

use std::time::{Duration, Instant};

use serde::Serialize;

/// The job name we give our own receipts, so we can recognise them in the queue
/// afterwards and tell "it printed" apart from "the spooler took it".
pub const DOCUMENT_NAME: &str = "Lyra PoS Receipt";

/// How long we let our job sit in the queue before deciding the printer never
/// took it. The spooler accepting the bytes says nothing about the printer
/// having them: a printer that has stopped responding leaves the job sitting
/// there, and every later receipt queues up behind it.
const QUEUE_WAIT: Duration = Duration::from_secs(8);
const QUEUE_POLL: Duration = Duration::from_millis(500);

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrinterInfo {
    pub name: String,
    pub display_name: String,
    pub is_default: bool,
}

/// Every printer the system knows about, for Setup's dropdown.
pub fn list_printers() -> Vec<PrinterInfo> {
    platform::list_printers()
}

/// Prints `text` as a receipt on `printer`, returning how many bytes reached it.
pub fn print_receipt_raw(printer: &str, text: &str, cut: bool) -> Result<usize, String> {
    let name = printer.trim();
    if name.is_empty() {
        return Err("No receipt printer selected in Setup.".to_string());
    }
    let bytes = crate::escpos::build_receipt(text, cut);
    platform::send_raw(name, &bytes)
}

// ---------------------------------------------------------------------------
// Windows: the spooler's RAW data type, through winspool
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod platform {
    use super::{DOCUMENT_NAME, Instant, PrinterInfo, QUEUE_POLL, QUEUE_WAIT};
    use std::ffi::c_void;
    use windows::Win32::Graphics::Printing::{
        ClosePrinter, DOC_INFO_1W, EndDocPrinter, EndPagePrinter, EnumJobsW, EnumPrintersW,
        GetDefaultPrinterW, JOB_CONTROL_DELETE, JOB_INFO_1W, JOB_STATUS_DELETING, JOB_STATUS_ERROR,
        JOB_STATUS_PRINTING, OpenPrinterW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL,
        PRINTER_HANDLE, PRINTER_INFO_4W, SetJobW, StartDocPrinterW, StartPagePrinter, WritePrinter,
    };
    use windows::core::{PCWSTR, PWSTR};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// A byte buffer that is aligned for the printer structs, which contain
    /// pointers. A plain `Vec<u8>` is only one-byte aligned, and reading a
    /// `PRINTER_INFO_4W` out of one would be undefined behaviour.
    struct AlignedBuf {
        words: Vec<u64>,
    }

    impl AlignedBuf {
        fn new(bytes: usize) -> Self {
            Self {
                words: vec![0u64; bytes.div_ceil(8).max(1)],
            }
        }

        fn as_bytes_mut(&mut self, len: usize) -> &mut [u8] {
            let len = len.min(self.words.len() * 8);
            // SAFETY: the allocation is at least 8-byte aligned and is exactly
            // `words.len() * 8` bytes long, so a `u8` view of `len` bytes is
            // in bounds and valid for writes.
            unsafe { std::slice::from_raw_parts_mut(self.words.as_mut_ptr() as *mut u8, len) }
        }

        fn start(&self) -> *const u8 {
            self.words.as_ptr() as *const u8
        }
    }

    /// Reads a NUL-terminated wide string out of the buffer the API filled in.
    ///
    /// SAFETY: `p` must point into a live buffer owned by the caller.
    unsafe fn read_wide(p: PWSTR) -> String {
        if p.is_null() {
            return String::new();
        }
        unsafe { p.to_string().unwrap_or_default() }
    }

    fn default_printer_name() -> Option<String> {
        let mut size = 0u32;
        // The sizing call reports the needed length and "fails"; that is expected.
        let _ = unsafe { GetDefaultPrinterW(None, &mut size) };
        if size == 0 {
            return None;
        }
        let mut buf = vec![0u16; size as usize];
        if unsafe { GetDefaultPrinterW(Some(PWSTR(buf.as_mut_ptr())), &mut size) }.as_bool() {
            let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            Some(String::from_utf16_lossy(&buf[..end]))
        } else {
            None
        }
    }

    pub fn list_printers() -> Vec<PrinterInfo> {
        let default = default_printer_name();
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let mut needed = 0u32;
        let mut returned = 0u32;

        let sizing =
            unsafe { EnumPrintersW(flags, PCWSTR::null(), 4, None, &mut needed, &mut returned) };
        // A zero need means there genuinely are no printers; anything else and
        // the sizing call did its job by reporting how much room it wants.
        if needed == 0 {
            let _ = sizing;
            return Vec::new();
        }

        let mut buf = AlignedBuf::new(needed as usize);
        let filled = unsafe {
            EnumPrintersW(
                flags,
                PCWSTR::null(),
                4,
                Some(buf.as_bytes_mut(needed as usize)),
                &mut needed,
                &mut returned,
            )
        };
        if filled.is_err() {
            return Vec::new();
        }

        let count = (returned as usize).min(buf.words.len() * 8 / size_of::<PRINTER_INFO_4W>());
        // SAFETY: `buf` holds `count` well-formed `PRINTER_INFO_4W` records that
        // the API just wrote, at the alignment those records require.
        let records =
            unsafe { std::slice::from_raw_parts(buf.start() as *const PRINTER_INFO_4W, count) };

        let mut printers: Vec<PrinterInfo> = records
            .iter()
            .map(|info| {
                let name = unsafe { read_wide(info.pPrinterName) };
                PrinterInfo {
                    is_default: Some(&name) == default.as_ref(),
                    display_name: name.clone(),
                    name,
                }
            })
            .filter(|p| !p.name.is_empty())
            .collect();

        printers.sort_by_key(|p| p.name.to_lowercase());
        printers
    }

    /// Sends `data` to `printer` as a RAW job.
    pub fn send_raw(printer: &str, data: &[u8]) -> Result<usize, String> {
        let name = wide(printer);
        let mut handle = PRINTER_HANDLE::default();
        unsafe { OpenPrinterW(PCWSTR(name.as_ptr()), &mut handle, None) }.map_err(|_| {
            format!(
                "Could not open printer '{printer}'. Is it installed, switched on and not paused?"
            )
        })?;

        let result = send_with_handle(handle, printer, data);
        // The handle must be released whichever way the print went.
        let closed = unsafe { ClosePrinter(handle) };
        if result.is_ok() {
            closed.map_err(|_| "The printer connection failed to close.".to_string())?;
        }
        result
    }

    fn send_with_handle(
        handle: PRINTER_HANDLE,
        printer: &str,
        data: &[u8],
    ) -> Result<usize, String> {
        // A receipt left behind by an earlier stalled attempt would sit in front
        // of this one forever, so clear anything already wedged on the printer.
        clear_stuck_jobs(handle);

        let doc_name = wide(DOCUMENT_NAME);
        let datatype = wide("RAW");
        let info = DOC_INFO_1W {
            pDocName: PWSTR(doc_name.as_ptr() as *mut u16),
            pOutputFile: PWSTR::null(),
            pDatatype: PWSTR(datatype.as_ptr() as *mut u16),
        };

        let job = unsafe { StartDocPrinterW(handle, 1, &info) };
        if job == 0 {
            return Err(format!(
                "The spooler refused the receipt for '{printer}'. Check the printer is not paused."
            ));
        }

        if !unsafe { StartPagePrinter(handle) }.as_bool() {
            let _ = unsafe { EndDocPrinter(handle) };
            return Err("The printer would not start a page.".to_string());
        }

        let mut written = 0u32;
        let wrote = unsafe {
            WritePrinter(
                handle,
                data.as_ptr() as *const c_void,
                data.len() as u32,
                &mut written,
            )
        };
        let _ = unsafe { EndPagePrinter(handle) };
        let _ = unsafe { EndDocPrinter(handle) };

        if !wrote.as_bool() {
            return Err(format!(
                "The printer '{printer}' refused the receipt. Check it is switched on and has paper."
            ));
        }
        if written as usize != data.len() {
            return Err(format!(
                "Only {written} of {} bytes reached '{printer}'.",
                data.len()
            ));
        }

        wait_for_job_to_clear(handle, printer, job)?;
        Ok(written as usize)
    }

    /// Removes jobs already stuck on this printer, so a new receipt is never
    /// queued behind one that will never come out.
    fn clear_stuck_jobs(handle: PRINTER_HANDLE) {
        for (job_id, status) in jobs(handle) {
            let stuck =
                status & (JOB_STATUS_PRINTING | JOB_STATUS_DELETING | JOB_STATUS_ERROR) != 0;
            if stuck {
                let _ = unsafe { SetJobW(handle, job_id, 0, None, JOB_CONTROL_DELETE) };
            }
        }
    }

    /// Waits for our own job to leave the queue, and if it never does, drops it
    /// so the till stays usable and says so — rather than reporting a receipt
    /// that never came out.
    fn wait_for_job_to_clear(
        handle: PRINTER_HANDLE,
        printer: &str,
        job_id: u32,
    ) -> Result<(), String> {
        let deadline = Instant::now() + QUEUE_WAIT;
        loop {
            std::thread::sleep(QUEUE_POLL);
            let ours_still_queued = jobs(handle).into_iter().any(|(id, _)| id == job_id);
            if !ours_still_queued {
                return Ok(());
            }
            if Instant::now() >= deadline {
                let _ = unsafe { SetJobW(handle, job_id, 0, None, JOB_CONTROL_DELETE) };
                return Err(format!(
                    "The printer '{printer}' did not take the receipt. Check it is switched on, \
                     has paper, has no error light, and that its cable is firmly plugged in, \
                     then print it again."
                ));
            }
        }
    }

    /// The queue's jobs, as (job id, status bits).
    fn jobs(handle: PRINTER_HANDLE) -> Vec<(u32, u32)> {
        let mut needed = 0u32;
        let mut returned = 0u32;
        let _ = unsafe { EnumJobsW(handle, 0, 0xffff_ffff, 1, None, &mut needed, &mut returned) };
        if needed == 0 {
            return Vec::new();
        }

        let mut buf = AlignedBuf::new(needed as usize);
        let listed = unsafe {
            EnumJobsW(
                handle,
                0,
                0xffff_ffff,
                1,
                Some(buf.as_bytes_mut(needed as usize)),
                &mut needed,
                &mut returned,
            )
        };
        if listed.is_err() {
            return Vec::new();
        }

        let count = (returned as usize).min(buf.words.len() * 8 / size_of::<JOB_INFO_1W>());
        // SAFETY: `buf` holds `count` well-formed `JOB_INFO_1W` records the API
        // just wrote, at the alignment those records require.
        let records =
            unsafe { std::slice::from_raw_parts(buf.start() as *const JOB_INFO_1W, count) };
        records.iter().map(|j| (j.JobId, j.Status)).collect()
    }
}

// ---------------------------------------------------------------------------
// Everywhere else: CUPS, through `lp`
// ---------------------------------------------------------------------------

#[cfg(not(windows))]
mod platform {
    use super::{DOCUMENT_NAME, PrinterInfo};
    use std::io::Write;
    use std::process::{Command, Stdio};

    /// Asks CUPS for its printers. `lpstat` ships with CUPS, which is what any
    /// machine with a printer on it is already running.
    pub fn list_printers() -> Vec<PrinterInfo> {
        let Ok(output) = Command::new("lpstat").arg("-a").output() else {
            return Vec::new();
        };
        if !output.status.success() {
            return Vec::new();
        }
        let default = Command::new("lpstat")
            .arg("-d")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| {
                let text = String::from_utf8_lossy(&o.stdout).to_string();
                text.split_whitespace().last().map(str::to_string)
            });

        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.split_whitespace().next().map(str::to_string))
            .filter(|name| !name.is_empty())
            .map(|name| PrinterInfo {
                is_default: Some(&name) == default.as_ref(),
                display_name: name.clone(),
                name,
            })
            .collect()
    }

    pub fn send_raw(printer: &str, data: &[u8]) -> Result<usize, String> {
        // `-o raw` hands the bytes to the printer untouched, which is the whole
        // point of the ESC/POS path.
        let mut child = Command::new("lp")
            .arg("-d")
            .arg(printer)
            .arg("-o")
            .arg("raw")
            .arg("-t")
            .arg(DOCUMENT_NAME)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Could not start 'lp': {e}. Is CUPS installed?"))?;

        if let Some(stdin) = child.stdin.take() {
            let mut stdin = stdin;
            stdin
                .write_all(data)
                .map_err(|e| format!("Could not hand the receipt to 'lp': {e}"))?;
        }

        let output = child
            .wait_with_output()
            .map_err(|e| format!("'lp' failed: {e}"))?;
        if output.status.success() {
            Ok(data.len())
        } else {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(if err.is_empty() {
                format!("'lp' could not print to '{printer}'.")
            } else {
                err
            })
        }
    }
}
