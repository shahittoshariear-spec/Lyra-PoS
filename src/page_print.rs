//! Printing the window's own page, through WebView2, with no dialog.
//!
//! When the shop has not chosen a thermal printer, a receipt is printed by the
//! webview itself: the print stylesheet in `ui/styles.css` shows the receipt and
//! hides the rest of the app. The fallback used to be the webview's print
//! preview, which left a dialog on screen that had to be closed before the till
//! could be used again. WebView2 has a print call that never shows one.
//!
//! Two things about that call shape this module:
//!
//! - It has to be made on the thread that owns the webview, so the work is run
//!   inside `WebviewWindow::with_webview` and the result is sent back.
//! - It finishes by calling back through the window's own message queue, so the
//!   queue has to keep moving until it does. Pumping it is also how the deadline
//!   is enforced: a driver that never answers leaves the queue empty, and the
//!   wait ends on its own rather than leaving the till stuck.

use std::time::Duration;

/// How long the page is given to reach the printer's queue. Generous for a page
/// of A4 on a spooler that is working, and short enough that a till with a dead
/// printer is usable again within the minute.
pub const WAIT: Duration = Duration::from_secs(30);

/// The pause between two looks at the message queue, so that waiting for a slow
/// print does not spin a processor.
const PUMP_PAUSE: Duration = Duration::from_millis(10);

/// How many queued messages are dispatched before the wait looks at the clock
/// again. A window that is posting messages of its own must not be able to keep
/// the deadline from being reached.
const MESSAGES_PER_PASS: usize = 200;

/// Prints the webview's current page, to `printer` or to the Windows default
/// printer when no name is given.
pub fn print_page(
    webview: &tauri::webview::PlatformWebview,
    printer: Option<&str>,
) -> Result<(), String> {
    platform::print_page(webview, printer)
}

#[cfg(windows)]
mod platform {
    use super::{MESSAGES_PER_PASS, PUMP_PAUSE, WAIT};
    use std::sync::mpsc;
    use std::time::Instant;

    use tauri::webview::PlatformWebview;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PRINT_STATUS_PRINTER_UNAVAILABLE, COREWEBVIEW2_PRINT_STATUS_SUCCEEDED,
        ICoreWebView2_16, ICoreWebView2Environment6, ICoreWebView2PrintSettings2,
    };
    use webview2_com::PrintCompletedHandler;
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, MSG, PM_REMOVE, PeekMessageW, TranslateMessage,
    };
    // These come from the same build of windows-core that webview2-com's
    // interfaces were generated against: a wide string from the newer `windows`
    // crate would be a different type to the one the COM calls ask for.
    use windows_core::{Interface, PCWSTR};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn print_page(webview: &PlatformWebview, printer: Option<&str>) -> Result<(), String> {
        let printer = printer.map(str::trim).filter(|name| !name.is_empty());

        let core = unsafe { webview.controller().CoreWebView2() }.map_err(|_| {
            "The page is not ready to print yet. Try again in a moment.".to_string()
        })?;

        // Print arrived with WebView2 1.0.1518. Windows updates the runtime with
        // Edge, so this is only ever an unusually old machine — and it can be
        // told what to do about it rather than being left with a dialog.
        let webview16: ICoreWebView2_16 = core.cast().map_err(|_| {
            "This computer's WebView2 is too old to print without a dialog. \
             Install the Microsoft Edge WebView2 Runtime, or choose a receipt printer in Setup."
                .to_string()
        })?;
        let environment: ICoreWebView2Environment6 = webview
            .environment()
            .cast()
            .map_err(|_| "This computer's WebView2 cannot set up a print job.".to_string())?;

        let settings = unsafe { environment.CreatePrintSettings() }
            .map_err(|_| "Windows would not accept a print job.".to_string())?;
        // Left unset, the printer name is the Windows default printer — which is
        // what the shop wants when Setup has no receipt printer chosen. Only
        // naming one needs the newer settings interface, so a machine too old
        // for it still prints to the default printer rather than giving up.
        if let Some(name) = printer {
            let named: ICoreWebView2PrintSettings2 = settings.cast().map_err(|_| {
                "This computer's WebView2 cannot send a print job to a chosen printer. Set that \
                 printer as the Windows default printer, or leave Setup on 'Ask me each time'."
                    .to_string()
            })?;
            let wide_name = wide(name);
            unsafe { named.SetPrinterName(PCWSTR(wide_name.as_ptr())) }
                .map_err(|_| format!("The print job could not be sent to '{name}'."))?;
        }

        let (tx, rx) = mpsc::channel();
        let handler = PrintCompletedHandler::create(Box::new(move |result, status| {
            // A send that fails means the wait already gave up; nothing to do.
            let _ = tx.send((result.is_ok(), status.0));
            Ok(())
        }));
        unsafe { webview16.Print(&settings, &handler) }
            .map_err(|e| format!("The page could not be sent to the printer: {e}"))?;

        let deadline = Instant::now() + WAIT;
        let mut message = MSG::default();
        loop {
            for _ in 0..MESSAGES_PER_PASS {
                if !unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE) }.as_bool() {
                    break;
                }
                let _ = unsafe { TranslateMessage(&message) };
                unsafe { DispatchMessageW(&message) };
            }

            if let Ok((ok, status)) = rx.try_recv() {
                if ok && status == COREWEBVIEW2_PRINT_STATUS_SUCCEEDED.0 {
                    return Ok(());
                }
                return Err(explain(status, printer));
            }

            if Instant::now() >= deadline {
                return Err(format!(
                    "The page did not reach {} within {} seconds. Check the printer is switched \
                     on, has paper and is not paused, then print again.",
                    named(printer),
                    WAIT.as_secs()
                ));
            }
            std::thread::sleep(PUMP_PAUSE);
        }
    }

    /// What WebView2's print status means in words a shopkeeper can act on.
    fn explain(status: i32, printer: Option<&str>) -> String {
        if status == COREWEBVIEW2_PRINT_STATUS_PRINTER_UNAVAILABLE.0 {
            return match printer {
                Some(name) => format!(
                    "The printer '{name}' is not available. Check it is switched on and not \
                     paused, then print again."
                ),
                None => "There is no printer for the page to go to. Set a default printer in \
                         Windows, or choose a receipt printer in Setup."
                    .to_string(),
            };
        }
        format!(
            "{} did not accept the page. Check it is switched on, has paper and is not \
             paused, then print again.",
            named(printer)
        )
    }

    fn named(printer: Option<&str>) -> String {
        match printer {
            Some(name) => format!("'{name}'"),
            None => "the default printer".to_string(),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn a_failure_names_the_printer_and_says_what_to_do() {
            // What WebView2 reports when there is nothing to print to.
            let none_chosen = explain(COREWEBVIEW2_PRINT_STATUS_PRINTER_UNAVAILABLE.0, None);
            assert!(none_chosen.contains("default printer"));
            assert!(none_chosen.contains("Windows"));

            let chosen = explain(
                COREWEBVIEW2_PRINT_STATUS_PRINTER_UNAVAILABLE.0,
                Some("EPSON TM-T20"),
            );
            assert!(chosen.contains("EPSON TM-T20"));

            // Any other status is still a sentence rather than a number.
            let other = explain(2, Some("EPSON"));
            assert!(other.contains("EPSON"));
            assert!(other.contains("paper"));
            assert!(!other.contains('2'));
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use tauri::webview::PlatformWebview;

    /// The app is built for Windows; this keeps the rest of the crate building
    /// elsewhere for tests and for a look at the code.
    pub fn print_page(_webview: &PlatformWebview, _printer: Option<&str>) -> Result<(), String> {
        Err("Printing the page without a dialog is only available on Windows.".to_string())
    }
}
