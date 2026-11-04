<?php
declare(strict_types=1);
// E-mail sending: SMTP (SSL / STARTTLS / none) with PHP mail() as a fallback. No external libraries.
require_once __DIR__ . '/lib.php';

function mail_settings(): array
{
    return [
        'host' => (string)(get_setting('smtp_host') ?? ''), 'port' => (int)(get_setting('smtp_port') ?: 465), 'enc' => (string)(get_setting('smtp_enc') ?: 'ssl'),
        'user' => (string)(get_setting('smtp_user') ?? ''), 'pass' => (string)(get_setting('smtp_pass') ?? ''),
        'from' => (string)(get_setting('mail_from') ?? ''), 'name' => (string)(get_setting('mail_from_name') ?: (get_setting('company_name') ?: 'Infraura')),
    ];
}

/** True when the app can send mail (SMTP host, or a From address for PHP mail()). */
function mail_configured(): bool
{
    $s = mail_settings();
    return $s['host'] !== '' || $s['from'] !== '';
}

function mail_clean_header(string $v): string
{
    return trim(preg_replace('/[\r\n]+/', ' ', $v));
}

function mail_encode_subject(string $s): string
{
    $s = mail_clean_header($s);
    return preg_match('/[^\x20-\x7e]/', $s) ? '=?UTF-8?B?' . base64_encode($s) . '?=' : $s;
}

function smtp_read($fp): array
{ // returns [code, fullText]; handles multi-line replies
    $text = ''; $code = 0;
    while (($line = fgets($fp, 1024)) !== false) {
        $text .= $line;
        $code = (int)substr($line, 0, 3);
        if (strlen($line) < 4 || $line[3] !== '-') break;
    }
    return [$code, trim($text)];
}
function smtp_cmd($fp, string $cmd, array $okCodes): string
{
    fwrite($fp, $cmd . "\r\n");
    [$code, $text] = smtp_read($fp);
    if (!in_array($code, $okCodes, true)) throw new RuntimeException('SMTP error ' . $code . ': ' . substr($text, 0, 160));
    return $text;
}

/** Send one message. Returns [bool ok, string error]. Every attempt is written to email_log. */
function send_mail(string $to, string $subject, string $html, ?string $text = null): array
{
    $to = mail_clean_header($to);
    if (!filter_var($to, FILTER_VALIDATE_EMAIL)) return [false, 'Invalid recipient address'];
    $s = mail_settings();
    $fromAddr = $s['from'] !== '' ? $s['from'] : ($s['user'] !== '' && filter_var($s['user'], FILTER_VALIDATE_EMAIL) ? $s['user'] : 'no-reply@' . preg_replace('/^www\./', '', (string)($_SERVER['HTTP_HOST'] ?? 'localhost')));
    if (!filter_var($fromAddr, FILTER_VALIDATE_EMAIL)) return [false, 'The From address in Settings is not a valid e-mail address'];
    $text = $text ?? trim(html_entity_decode(strip_tags(preg_replace('#<(br|/p|/div|/tr|/h\d)[^>]*>#i', "\n", $html)), ENT_QUOTES, 'UTF-8'));
    $boundary = 'b' . bin2hex(random_bytes(12));
    $fromHeader = '=?UTF-8?B?' . base64_encode(mail_clean_header($s['name'])) . '?= <' . $fromAddr . '>';
    $domain = substr(strrchr($fromAddr, '@') ?: '@localhost', 1);
    $headers = ['Date: ' . date('r'), 'From: ' . $fromHeader, 'To: <' . $to . '>', 'Subject: ' . mail_encode_subject($subject), 'Message-ID: <' . bin2hex(random_bytes(12)) . '@' . $domain . '>',
        'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="' . $boundary . '"'];
    $body = "--$boundary\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" . chunk_split(base64_encode($text)) . "--$boundary\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" . chunk_split(base64_encode($html)) . "--$boundary--\r\n";
    $ok = false; $err = '';
    try {
        if ($s['host'] !== '') {
            $enc = in_array($s['enc'], ['ssl', 'tls', 'none'], true) ? $s['enc'] : 'ssl';
            $ctx = stream_context_create(['ssl' => ['verify_peer' => $enc !== 'none', 'verify_peer_name' => $enc !== 'none', 'SNI_enabled' => true]]);
            $fp = @stream_socket_client(($enc === 'ssl' ? 'ssl://' : 'tcp://') . $s['host'] . ':' . $s['port'], $en, $es, 12, STREAM_CLIENT_CONNECT, $ctx);
            if (!$fp) throw new RuntimeException('Could not connect to the mail server (' . $es . ')');
            stream_set_timeout($fp, 15);
            [$code, $banner] = smtp_read($fp); if ($code !== 220) throw new RuntimeException('Mail server did not greet us: ' . substr($banner, 0, 100));
            $ehlo = preg_replace('/[^a-z0-9.\-]/i', '', (string)($_SERVER['HTTP_HOST'] ?? 'localhost')) ?: 'localhost';
            smtp_cmd($fp, 'EHLO ' . $ehlo, [250]);
            if ($enc === 'tls') {
                smtp_cmd($fp, 'STARTTLS', [220]);
                if (!stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) throw new RuntimeException('Could not start TLS with the mail server');
                smtp_cmd($fp, 'EHLO ' . $ehlo, [250]);
            }
            if ($s['user'] !== '') {
                smtp_cmd($fp, 'AUTH LOGIN', [334]); smtp_cmd($fp, base64_encode($s['user']), [334]); smtp_cmd($fp, base64_encode($s['pass']), [235]);
            }
            smtp_cmd($fp, 'MAIL FROM:<' . $fromAddr . '>', [250]); smtp_cmd($fp, 'RCPT TO:<' . $to . '>', [250, 251]); smtp_cmd($fp, 'DATA', [354]);
            $msg = implode("\r\n", $headers) . "\r\n\r\n" . $body;
            $msg = preg_replace('/^\./m', '..', str_replace(["\r\n", "\r"], "\n", $msg)); $msg = str_replace("\n", "\r\n", $msg);
            fwrite($fp, $msg . "\r\n.\r\n"); [$code, $t] = smtp_read($fp);
            if ($code !== 250) throw new RuntimeException('Mail server rejected the message: ' . substr($t, 0, 120));
            @smtp_cmd($fp, 'QUIT', [221]); @fclose($fp);
            $ok = true;
        } else {
            $h2 = array_values(array_filter($headers, fn($h) => !preg_match('/^(To|Subject):/i', $h)));
            $ok = @mail($to, mail_encode_subject($subject), $body, implode("\r\n", $h2));
            if (!$ok) throw new RuntimeException('PHP mail() could not send the message. Set up SMTP in Settings (your hosting e-mail account) for reliable delivery.');
        }
    } catch (Throwable $e) {
        $err = preg_replace('/' . preg_quote($s['pass'] ?: "\x00", '/') . '/', '***', $e->getMessage());
    }
    try { q('INSERT INTO email_log (recipient,subject,status,error,created_at) VALUES (?,?,?,?,?)', [mb_substr($to, 0, 190), mb_substr($subject, 0, 250), $ok ? 'sent' : 'failed', mb_substr($err, 0, 480), now()]); } catch (Throwable $e) { /* log table missing: ignore */ }
    return [$ok, $err];
}

/** Branded wrapper for transactional mail. $button = [text, url] or null. */
function email_html(string $heading, string $bodyHtml, ?array $button = null): string
{
    $co = htmlspecialchars((string)(get_setting('company_name') ?: 'Infraura'), ENT_QUOTES, 'UTF-8');
    $btn = $button ? '<p style="margin:22px 0"><a href="' . htmlspecialchars($button[1], ENT_QUOTES, 'UTF-8') . '" style="background:#d4af37;color:#000;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px;display:inline-block">' . htmlspecialchars($button[0], ENT_QUOTES, 'UTF-8') . '</a></p><p style="font-size:12px;color:#777">If the button does not work, copy this link:<br>' . htmlspecialchars($button[1], ENT_QUOTES, 'UTF-8') . '</p>' : '';
    return '<!doctype html><html><body style="margin:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif"><div style="max-width:560px;margin:24px auto;background:#fff;border-radius:10px;overflow:hidden"><div style="background:#000;color:#d4af37;padding:18px 24px;font-size:20px;font-weight:700">' . $co . '</div><div style="padding:24px;color:#222;font-size:15px;line-height:1.5"><h2 style="margin:0 0 12px;font-size:18px">' . htmlspecialchars($heading, ENT_QUOTES, 'UTF-8') . '</h2>' . $bodyHtml . $btn . '</div></div></body></html>';
}
