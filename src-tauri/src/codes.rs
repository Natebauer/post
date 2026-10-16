//! Finding one-time / verification / confirmation codes in an email, so the notification can
//! show the code itself (and copy it) without opening the message.

use once_cell::sync::Lazy;
use regex::Regex;

/// Words that mean "this email carries a code".
static CUE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)\b(code|passcode|pass code|otp|one[- ]time|verification|verify|confirmation number|confirmation code|security code|sign[- ]in|log[- ]?in|2fa|two[- ]factor|pin)\b",
    )
    .unwrap()
});

/// Candidate codes: 4–8 digits (optionally split "123 456" / "123-456"), Google's "G-123456",
/// or a 6–8 character mix of capitals and digits ("K7Q2XM").
static CANDIDATE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\b(G-\d{4,8}|\d{3}[ -]\d{3}|\d{4,8}|[A-Z0-9]{6,8})\b").unwrap()
});

fn plausible(token: &str, before: &str, after: &str) -> bool {
    let digits = token.chars().filter(|c| c.is_ascii_digit()).count();
    let letters = token.chars().filter(|c| c.is_ascii_alphabetic()).count();
    // A mix of capitals needs at least two digits (rules out ordinary words in capitals).
    if !token.starts_with("G-") && letters > 0 && digits < 2 {
        return false;
    }
    // Years are four digits too.
    if letters == 0 && digits == 4 {
        if let Ok(n) = token.parse::<u32>() {
            if (1900..=2099).contains(&n) {
                return false;
            }
        }
    }
    let b = before.trim_end();
    let digit_follows = |s: &str| s.chars().nth(1).is_some_and(|c| c.is_ascii_digit());
    // Money, percentages, times, phone numbers and decimals aren't codes.
    let bad_before = b.ends_with('$') || b.ends_with('#') || b.ends_with('(') || before.ends_with('-') || before.ends_with('.');
    let bad_after = after.starts_with('%')
        || after.starts_with(':')
        || (after.starts_with('-') || after.starts_with('.')) && digit_follows(after);
    !bad_before && !bad_after
}

/// The most likely code in an email, if it looks like a code email at all.
pub fn find_code(subject: &str, text: &str) -> Option<String> {
    let body: String = text.chars().take(2000).collect();
    let hay = format!("{subject}\n{body}");
    let cues: Vec<usize> = CUE.find_iter(&hay).map(|m| m.start()).collect();
    if cues.is_empty() {
        return None;
    }
    let mut best: Option<(usize, String)> = None;
    for m in CANDIDATE.find_iter(&hay) {
        let token = m.as_str();
        if !plausible(token, &hay[..m.start()], &hay[m.end()..]) {
            continue;
        }
        // The candidate closest to a cue word wins.
        let dist = cues.iter().map(|&c| c.abs_diff(m.start())).min().unwrap_or(usize::MAX);
        if dist > 160 || best.as_ref().is_some_and(|(d, _)| dist >= *d) {
            continue;
        }
        let code = if token.starts_with("G-") { token.to_string() } else { token.replace([' ', '-'], "") };
        best = Some((dist, code));
    }
    best.map(|(_, code)| code)
}
#[cfg(test)]
mod tests {
    use super::find_code;

    #[test]
    fn finds_common_codes() {
        assert_eq!(find_code("Your verification code", "Your code is 482911. It expires in 10 minutes."), Some("482911".into()));
        assert_eq!(find_code("G-519302 is your Google verification code", ""), Some("G-519302".into()));
        assert_eq!(find_code("Sign in to Acme", "Here is the code you need: K7Q2XM"), Some("K7Q2XM".into()));
        assert_eq!(find_code("Security code", "Enter 123 456 to continue"), Some("123456".into()));
        assert_eq!(find_code("Your confirmation number", "Confirmation number: 8842"), Some("8842".into()));
    }

    #[test]
    fn ignores_ordinary_mail() {
        assert_eq!(find_code("Dinner Saturday?", "We're thinking 7:30 at that Ethiopian place, 2026 menu."), None);
        assert_eq!(find_code("Your receipt", "Total $1299. Thanks for your order."), None);
        assert_eq!(find_code("Code review notes", "Looks good, see the 2026 roadmap."), None);
    }
}
