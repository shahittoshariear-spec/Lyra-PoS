//! Emailing the day's report through the shop's own Gmail account.
//!
//! The password is the only secret this app holds. It lives in Windows
//! Credential Manager and never in the shop's data file: that file is copied to
//! a USB stick for a backup and opened by hand when something looks wrong, so a
//! password in it would travel with it. Nothing here logs it, and there is no
//! command that hands it back to the screens — Setup can only ask whether one is
//! saved.
//!
//! The report itself is an attachment rather than a page of HTML: it is the same
//! PDF the shop can print, so what the owner reads on a phone is what a customer
//! would be handed.

use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{Message, SmtpTransport, Transport};
use serde::Deserialize;

use crate::report::{self, DailyReport};

/// Where the app password is filed in Windows Credential Manager. The target
/// name is fixed, because it is what has to be found again on the next launch.
pub const CREDENTIAL_TARGET: &str = "Lyra PoS: mail app password";
const CREDENTIAL_USER: &str = "lyra-pos";

/// How long a connection, or a reply after it, is given before it is a failure.
const REPLY_WAIT: Duration = Duration::from_secs(20);

/// The ceiling on the whole send, however the sockets behave. A report that
/// cannot go out in a minute is not going out, and the shopkeeper needs the
/// till back rather than a spinner.
const SEND_DEADLINE: Duration = Duration::from_secs(60);

/// Gmail's own server, used when Setup has not said otherwise.
const DEFAULT_HOST: &str = "smtp.gmail.com";
/// Port 465 speaks TLS from the first byte; anything else is treated as the
/// submission port, which starts in the clear and is upgraded.
const IMPLICIT_TLS_PORT: u16 = 465;

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct MailRequest {
    pub recipient: String,
    pub sender_name: String,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub username: String,
    pub subject: String,
    pub body_text: String,
    pub report: DailyReport,
}

/// Keeps the shop's app password, or forgets it when given nothing.
pub fn save_password(password: &str) -> Result<(), String> {
    save_to(CREDENTIAL_TARGET, password)
}

/// As [`save_password`], for the target name it is to be filed under.
///
/// Google shows an App Password as four groups of four, and the spaces are only
/// there to be read: a pasted one with them in it would be refused, so they are
/// taken out here rather than left for the shopkeeper to notice.
fn save_to(target: &str, password: &str) -> Result<(), String> {
    let stripped: String = password.chars().filter(|ch| !ch.is_whitespace()).collect();
    if stripped.is_empty() {
        return platform::forget(target);
    }
    platform::save(target, CREDENTIAL_USER, &stripped)
}

/// Whether a password is saved, without saying anything about what it is.
pub fn has_password() -> bool {
    platform::password(CREDENTIAL_TARGET).is_some()
}

/// Builds the day's report and emails it as an attachment.
pub fn send_daily_report(request: MailRequest) -> Result<(), String> {
    let ready = ready(&request)?;
    let Some(password) = platform::password(CREDENTIAL_TARGET) else {
        return Err(
            "No email password is saved. Add the Gmail App Password in Setup, then send again."
                .to_string(),
        );
    };

    let email = compose(&request, &ready)?;
    deliver(&ready, &password, email)
}

/// A request that has been checked and filled in, so that nothing is put on a
/// socket until the reason it cannot be sent is either gone or a sentence the
/// shopkeeper can read.
#[derive(Debug)]
struct Ready {
    recipient: String,
    username: String,
    host: String,
    port: u16,
}

fn ready(request: &MailRequest) -> Result<Ready, String> {
    let username = request.username.trim().to_string();
    if username.is_empty() {
        return Err("Setup has no Gmail address to send from.".to_string());
    }
    let recipient = request.recipient.trim().to_string();
    if recipient.is_empty() {
        return Err(
            "There is no email address for the report to go to. Add one in Setup.".to_string(),
        );
    }
    // The frontend sends the host and port it means to use; these are the ones
    // that stand in for saying nothing at all.
    let host = match request.smtp_host.trim() {
        "" => DEFAULT_HOST.to_string(),
        host => host.to_string(),
    };
    let port = match request.smtp_port {
        0 => IMPLICIT_TLS_PORT,
        port => port,
    };
    Ok(Ready {
        recipient,
        username,
        host,
        port,
    })
}

/// The message itself: the owner's own words as the body, with the report
/// attached under a name they can find again in their inbox.
fn compose(request: &MailRequest, ready: &Ready) -> Result<Message, String> {
    let address = ready
        .username
        .parse()
        .map_err(|_| format!("'{}' does not look like an email address.", ready.username))?;
    let name = request.sender_name.trim();
    let from = Mailbox::new(
        match name {
            "" => None,
            name => Some(name.to_string()),
        },
        address,
    );
    let to = ready
        .recipient
        .parse()
        .map_err(|_| format!("'{}' does not look like an email address.", ready.recipient))?;

    let label = request.report.date_label.trim();
    let subject = match request.subject.trim() {
        "" if label.is_empty() => "Day report".to_string(),
        "" => format!("Day report for {label}"),
        subject => subject.to_string(),
    };
    let body = match request.body_text.trim() {
        "" if label.is_empty() => "The day's report is attached.".to_string(),
        "" => format!("The day's report for {label} is attached."),
        _ => request.body_text.clone(),
    };

    let pdf = report::render_pdf(&request.report);
    let pdf_type = ContentType::parse("application/pdf")
        .map_err(|_| "The report could not be attached.".to_string())?;

    Message::builder()
        .from(from)
        .to(to)
        .date_now()
        .subject(subject)
        .multipart(
            MultiPart::mixed()
                .singlepart(SinglePart::plain(body))
                .singlepart(Attachment::new(attachment_name(label)).body(pdf, pdf_type)),
        )
        .map_err(|e| format!("The email could not be put together: {e}"))
}

/// The file name the attachment arrives under, taken from the day it covers.
fn attachment_name(label: &str) -> String {
    let mut slug = String::new();
    for ch in label.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_end_matches('-');
    match slug {
        "" => "Lyra-PoS-day-report.pdf".to_string(),
        slug => format!("day-report-{slug}.pdf"),
    }
}

/// Sends the message, giving up after [`SEND_DEADLINE`] whatever the sockets are
/// doing. The thread doing the sending is left to finish on its own: joining
/// that thread is the very wait this bound exists to avoid.
fn deliver(ready: &Ready, password: &str, email: Message) -> Result<(), String> {
    let host = ready.host.as_str();
    let tls = TlsParameters::new(host.to_string())
        .map_err(|e| format!("The secure connection to {host} could not be set up: {e}"))?;
    // Port 465 is TLS from the first byte (what Gmail calls SSL). The submission
    // port starts in the clear and lettre upgrades it with STARTTLS when TLS is
    // required, so 587 works without a second path through this code.
    let tls = if ready.port == IMPLICIT_TLS_PORT {
        Tls::Wrapper(tls)
    } else {
        Tls::Required(tls)
    };

    let mailer = SmtpTransport::builder_dangerous(host)
        .port(ready.port)
        .tls(tls)
        .credentials(Credentials::new(
            ready.username.clone(),
            password.to_string(),
        ))
        .timeout(Some(REPLY_WAIT))
        .build();

    let (tx, rx) = mpsc::channel();
    let host = host.to_string();
    thread::spawn(move || {
        let _ = tx.send(
            mailer
                .send(&email)
                .map_err(|e| explain(&e, &host))
                .map(|_| ()),
        );
    });

    match rx.recv_timeout(SEND_DEADLINE) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => Err(
            "Sending the report took longer than a minute. Check the internet connection, then \
             try again."
                .to_string(),
        ),
        // The sending thread stopped without answering at all, which to a shop
        // is the same thing as a server that never answered.
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("Could not reach Gmail — check the internet connection.".to_string())
        }
    }
}

/// What an SMTP failure means in words a shopkeeper can act on.
///
/// The two that matter are told apart from everything else: a shop with no
/// internet, and a password Gmail will not accept. They have different fixes, so
/// they must not share a message.
fn explain(error: &lettre::transport::smtp::Error, host: &str) -> String {
    if let Some(code) = error.status() {
        let code = u16::from(code);
        return match known_reply(code) {
            Some(message) => message,
            None => format!("Gmail refused the report (code {code}): {error}"),
        };
    }

    if error.is_timeout() {
        return "Could not reach Gmail — check the internet connection.".to_string();
    }
    if error.is_tls() {
        return format!(
            "The secure connection to {host} could not be made. Check the internet connection."
        );
    }
    if !error.is_response() {
        // No reply from anything: no internet, no route to the server, or a
        // firewall in the way. The shop can only check the one of those it owns.
        return "Could not reach Gmail — check the internet connection.".to_string();
    }
    format!("The report could not be sent: {error}")
}

/// The server replies that have a fix the shopkeeper can carry out. Anything
/// else is passed on as it came, because it is a fault at the server rather than
/// at the till.
fn known_reply(code: u16) -> Option<String> {
    match code {
        // Gmail refusing the password, with or without a second factor in the way.
        // The reply that arrives almost every time this happens is a shopkeeper
        // having typed their ordinary Google password, so the message names the
        // fix and where to get it rather than saying "authentication failed".
        534 | 535 => Some(
            "Gmail refused the password. Gmail never accepts an ordinary Google account password \
             over email — it needs a 16-character App Password. Turn on 2-step verification for \
             the account, make an App Password at myaccount.google.com/apppasswords, then save it \
             in Setup → Day report by email."
                .to_string(),
        ),
        // 421 is the server closing a connection it cannot serve, 454 is a
        // temporary authentication failure after too many attempts in a row.
        421 | 454 => Some(
            "Gmail was too busy to take the report just now. Try again in a minute.".to_string(),
        ),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Windows: the Credential Manager
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;

    use windows::Win32::Foundation::ERROR_NOT_FOUND;
    use windows::Win32::Security::Credentials::{
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree,
        CredReadW, CredWriteW,
    };
    use windows::core::{HRESULT, PCWSTR};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn save(target: &str, user: &str, password: &str) -> Result<(), String> {
        let mut target = wide(target);
        let mut user = wide(user);
        // Generic credential blobs are the app's own bytes; UTF-16 is what
        // Windows' own tools put here, and it keeps an accented password whole.
        let mut blob: Vec<u8> = password.encode_utf16().flat_map(u16::to_le_bytes).collect();

        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: windows::core::PWSTR(target.as_mut_ptr()),
            UserName: windows::core::PWSTR(user.as_mut_ptr()),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            // Saved for this machine rather than for this session, so the till
            // still sends reports after a restart.
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };

        // SAFETY: every pointer in `credential` points at a live local buffer
        // that stays in place for the length of the call.
        unsafe { CredWriteW(&credential, 0) }.map_err(|_| {
            "Windows would not save the email password. Try again, or check that this Windows \
             account is allowed to use Credential Manager."
                .to_string()
        })
    }

    pub fn forget(target: &str) -> Result<(), String> {
        let target = wide(target);
        // SAFETY: `target` is a live NUL-terminated wide string for the call.
        match unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) } {
            Ok(()) => Ok(()),
            // Nothing was saved under that name: forgetting it has still done
            // what was asked, and Setup should not be told off for it.
            Err(e) if e.code() == HRESULT::from_win32(ERROR_NOT_FOUND.0) => Ok(()),
            Err(_) => Err("Windows would not remove the saved email password.".to_string()),
        }
    }

    pub fn password(target: &str) -> Option<String> {
        let target = wide(target);
        let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: the out-pointer is null on entry, as the API requires, and
        // points at memory this call allocates on success.
        unsafe {
            CredReadW(
                PCWSTR(target.as_ptr()),
                CRED_TYPE_GENERIC,
                None,
                &mut credential,
            )
        }
        .ok()?;
        if credential.is_null() {
            return None;
        }

        // SAFETY: `credential` is a CREDENTIALW the API just filled in, and its
        // blob is `CredentialBlobSize` bytes long.
        let read = unsafe { &*credential };
        let units = unsafe {
            std::slice::from_raw_parts(
                read.CredentialBlob as *const u16,
                read.CredentialBlobSize as usize / 2,
            )
        };
        let password = String::from_utf16_lossy(units);

        // SAFETY: the buffer came from CredReadW, which requires CredFree, and
        // the password has been copied out of it already.
        unsafe { CredFree(credential as *const c_void) };

        match password.is_empty() {
            true => None,
            false => Some(password),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// The part of this module that can be exercised without a mail server:
        /// Windows Credential Manager, out and back. It files under a target
        /// name of its own so that a password saved in Setup is never touched,
        /// and removes what it wrote before it finishes.
        #[test]
        fn a_password_round_trips_through_credential_manager() {
            const TARGET: &str = "Lyra PoS: self-test — safe to delete";
            // A run that stopped before its clean-up must not fail the next one.
            let _ = forget(TARGET);

            // Google shows an App Password as four groups of four, and the
            // spaces are for reading rather than for sending.
            crate::mail::save_to(TARGET, "abcd efgh ijkl mnop").expect("saving should work");
            assert_eq!(password(TARGET).as_deref(), Some("abcdefghijklmnop"));

            // Saving again replaces what was there rather than adding a second.
            crate::mail::save_to(TARGET, "second").expect("saving over one should work");
            assert_eq!(password(TARGET).as_deref(), Some("second"));

            // An empty password is how Setup forgets one.
            crate::mail::save_to(TARGET, "   ").expect("an empty password should forget it");
            assert!(password(TARGET).is_none());
            // Forgetting one that was never saved is not a failure either.
            crate::mail::save_to(TARGET, "").expect("forgetting nothing should be fine");
        }
    }
}

#[cfg(not(windows))]
mod platform {
    /// The app is built for Windows; this keeps the rest of the crate building
    /// elsewhere for tests and for a look at the code.
    pub fn save(_target: &str, _user: &str, _password: &str) -> Result<(), String> {
        Err("Saving an email password is only available on Windows.".to_string())
    }

    pub fn forget(_target: &str) -> Result<(), String> {
        Err("Saving an email password is only available on Windows.".to_string())
    }

    pub fn password(_target: &str) -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_is_checked_before_anything_is_sent() {
        // Nothing filled in at all: the address to send from is the first thing
        // Setup has to have.
        let empty = MailRequest::default();
        assert!(ready(&empty).unwrap_err().contains("Gmail address"));

        let no_recipient = MailRequest {
            username: "shop@gmail.com".to_string(),
            ..MailRequest::default()
        };
        assert!(ready(&no_recipient).unwrap_err().contains("email address"));

        // Host and port fall back to Gmail's own, which is what an empty Setup
        // means rather than a connection to nowhere.
        let filled = ready(&MailRequest {
            username: " shop@gmail.com ".to_string(),
            recipient: "owner@example.com".to_string(),
            ..MailRequest::default()
        })
        .expect("a filled-in request should be ready");
        assert_eq!(filled.host, "smtp.gmail.com");
        assert_eq!(filled.port, 465);
        assert_eq!(filled.username, "shop@gmail.com");

        let submission = ready(&MailRequest {
            username: "shop@gmail.com".to_string(),
            recipient: "owner@example.com".to_string(),
            smtp_host: "smtp.example.com".to_string(),
            smtp_port: 587,
            ..MailRequest::default()
        })
        .expect("a request with its own server should be ready");
        assert_eq!(submission.host, "smtp.example.com");
        assert_eq!(submission.port, 587);
    }

    #[test]
    fn the_attachment_is_named_after_the_day_it_covers() {
        assert_eq!(
            attachment_name("Tuesday, 23 September 2026"),
            "day-report-Tuesday-23-September-2026.pdf"
        );
        // Nothing usable to name it after still gives a file the owner can find.
        assert_eq!(attachment_name("   "), "Lyra-PoS-day-report.pdf");
        assert_eq!(attachment_name("2026-09-23"), "day-report-2026-09-23.pdf");
    }

    #[test]
    fn a_refused_password_is_told_apart_from_a_server_that_is_busy() {
        // What Gmail actually answers a wrong App Password with.
        let refused = known_reply(535).expect("535 should have a message of its own");
        assert!(refused.contains("App Password"));
        assert!(!refused.contains("internet"));
        assert!(
            known_reply(534)
                .expect("534 should too")
                .contains("App Password")
        );

        // "Too many login attempts", which is worth waiting out rather than
        // hunting for a new password.
        let busy = known_reply(454).expect("454 should have a message of its own");
        assert!(busy.contains("again"));
        assert!(!busy.contains("App Password"));

        // Anything else is the server's own words, untouched.
        assert!(known_reply(550).is_none());
    }
}
