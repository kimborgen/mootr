package llm

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"stam/internal/jsjson"
)

// AWS Signature Version 4 (src/llm/sigv4.ts, S-2117): the header form, for the one request kind stam signs (a Bedrock
// Converse POST). Never log what Sign returns: the authorization header carries a signature.

// spaces is /\s+/ with JavaScript's \s.
var spaces = regexp.MustCompile(`[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)

// awsCredentials are AWS credentials from the chain. Never in an error, an event or a log line.
type awsCredentials struct {
	accessKeyID, secretAccessKey, sessionToken string
}

// rfc3986 is encode: every byte but A-Z a-z 0-9 - _ . ~ as %XX.
func rfc3986(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || '0' <= c && c <= '9' || c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// amzDate is a time as 20150830T123600Z.
func amzDate(t time.Time) string { return t.UTC().Format("20060102T150405Z") }

func hexSHA(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func hmacSHA(key []byte, s string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(s))
	return m.Sum(nil)
}

// sign is sign: the headers to add (x-amz-date, x-amz-security-token with a session token, and authorization) for the
// method, the URL (its path as sent, already encoded), the given headers plus host, and the body.
func sign(method, rawURL string, headers map[string]string, body, service, region string, c awsCredentials, now time.Time) (map[string]string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	date := amzDate(now)
	day := date[:8]
	added := map[string]string{"x-amz-date": date}
	if c.sessionToken != "" {
		added["x-amz-security-token"] = c.sessionToken
	}
	all := map[string]string{"host": whatwgHost(u)}
	for _, src := range []map[string]string{headers, added} {
		for k, v := range src {
			all[strings.ToLower(k)] = spaces.ReplaceAllString(jsjson.Trim(v), " ")
		}
	}
	names := make([]string, 0, len(all))
	for n := range all {
		names = append(names, n)
	}
	sort.Strings(names)
	// Services other than S3 sign each path segment encoded once more than it is sent.
	segs := strings.Split(whatwgPath(rawURL), "/")
	for i, s := range segs {
		segs[i] = rfc3986(s)
	}
	path := strings.Join(segs, "/")
	if path == "" {
		path = "/"
	}
	pairs := searchParams(u.RawQuery)
	for i, p := range pairs {
		pairs[i] = [2]string{rfc3986(p[0]), rfc3986(p[1])}
	}
	sort.SliceStable(pairs, func(i, j int) bool {
		if pairs[i][0] != pairs[j][0] {
			return pairs[i][0] < pairs[j][0]
		}
		return pairs[i][1] < pairs[j][1]
	})
	query := make([]string, len(pairs))
	for i, p := range pairs {
		query[i] = p[0] + "=" + p[1]
	}
	var canon strings.Builder
	for _, n := range names {
		canon.WriteString(n + ":" + all[n] + "\n")
	}
	signed := strings.Join(names, ";")
	canonical := strings.Join([]string{strings.ToUpper(method), path, strings.Join(query, "&"), canon.String(), signed, hexSHA(body)}, "\n")
	scope := day + "/" + region + "/" + service + "/aws4_request"
	toSign := strings.Join([]string{"AWS4-HMAC-SHA256", date, scope, hexSHA(canonical)}, "\n")
	key := hmacSHA(hmacSHA(hmacSHA(hmacSHA([]byte("AWS4"+c.secretAccessKey), day), region), service), "aws4_request")
	added["authorization"] = "AWS4-HMAC-SHA256 Credential=" + c.accessKeyID + "/" + scope + ", SignedHeaders=" + signed + ", Signature=" + hex.EncodeToString(hmacSHA(key, toSign))
	return added, nil
}

// whatwgHost is new URL(u).host: lowercased, without the scheme's default port.
func whatwgHost(u *url.URL) string {
	h := strings.ToLower(u.Host)
	if def := map[string]string{"http": ":80", "https": ":443"}[strings.ToLower(u.Scheme)]; def != "" {
		h = strings.TrimSuffix(h, def)
	}
	return h
}

// whatwgPath is new URL(raw).pathname: the path as written, with what the URL standard's path percent-encode set holds
// (controls, space, " # < > ? ` { } and non-ASCII bytes) encoded, and escapes already there kept. Dot segments are not
// resolved; stam signs no URL that has them.
func whatwgPath(raw string) string {
	rest := raw
	if _, after, ok := strings.Cut(raw, "://"); ok {
		rest = after
	}
	i := strings.IndexAny(rest, "/?#")
	if i < 0 || rest[i] != '/' {
		return "/"
	}
	p := rest[i:]
	if j := strings.IndexAny(p, "?#"); j >= 0 {
		p = p[:j]
	}
	var b strings.Builder
	for k := 0; k < len(p); k++ {
		c := p[k]
		if c <= 0x20 || c >= 0x7f || strings.IndexByte("\"#<>?`{}", c) >= 0 {
			fmt.Fprintf(&b, "%%%02X", c)
		} else {
			b.WriteByte(c)
		}
	}
	return b.String()
}

// searchParams is new URL(raw).searchParams in order: pairs split on &, + as a space, and escapes decoded, with a
// malformed escape kept as written.
func searchParams(rawQuery string) [][2]string {
	var out [][2]string
	for _, part := range strings.Split(rawQuery, "&") {
		if part == "" {
			continue
		}
		k, v, _ := strings.Cut(part, "=")
		out = append(out, [2]string{formDecode(k), formDecode(v)})
	}
	return out
}

func formDecode(s string) string {
	s = strings.ReplaceAll(s, "+", " ")
	var b []byte
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) && isHex(s[i+1]) && isHex(s[i+2]) {
			n, _ := strconv.ParseUint(s[i+1:i+3], 16, 8)
			b = append(b, byte(n))
			i += 2
			continue
		}
		b = append(b, s[i])
	}
	return strings.ToValidUTF8(string(b), "\uFFFD")
}

func isHex(c byte) bool {
	return '0' <= c && c <= '9' || 'a' <= c && c <= 'f' || 'A' <= c && c <= 'F'
}
