// Package jsjson parses and prints JSON the way JavaScript's JSON.parse and JSON.stringify do, so a file the Go
// daemon writes is byte-identical to the one the TS daemon writes for the same input (S-2804): objects keep their
// keys in JavaScript's order (array-index keys first, ascending, then the rest in insertion order), a repeated key
// keeps its first position with its last value, numbers are doubles printed as Number#toString prints them, and
// strings escape only what JSON.stringify escapes (no HTML escaping, U+2028 and U+2029 as they are).
//
// A Value is nil (null), bool, float64 (or any Go integer when built by hand), string, []Value or *Object. A key
// that is absent stands for JavaScript's undefined: JSON.stringify leaves it out.
package jsjson

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Value is one JSON value; see the package comment for its Go types.
type Value = any

// Object is a JSON object with JavaScript's key order.
type Object struct {
	keys []string
	vals map[string]Value
}

// NewObject returns an empty object; pairs, if given, are set in order (key, value, key, value, ...).
func NewObject(pairs ...any) *Object {
	o := &Object{vals: map[string]Value{}}
	for i := 0; i+1 < len(pairs); i += 2 {
		o.Set(pairs[i].(string), pairs[i+1])
	}
	return o
}

// Set sets key to v: a new key goes last in insertion order, an existing one keeps its place (as `o[k] = v` and
// object spread do in JavaScript).
func (o *Object) Set(key string, v Value) {
	if o.vals == nil {
		o.vals = map[string]Value{}
	}
	if _, ok := o.vals[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.vals[key] = v
}

// Get returns key's value and whether it is present.
func (o *Object) Get(key string) (Value, bool) {
	if o == nil {
		return nil, false
	}
	v, ok := o.vals[key]
	return v, ok
}

// Len is the number of keys.
func (o *Object) Len() int {
	if o == nil {
		return 0
	}
	return len(o.keys)
}

// Keys returns the keys in JavaScript's order (Object.keys): array-index keys ascending, then the rest as inserted.
func (o *Object) Keys() []string {
	if o == nil {
		return nil
	}
	var idx, rest []string
	for _, k := range o.keys {
		if arrayIndex(k) {
			idx = append(idx, k)
		} else {
			rest = append(rest, k)
		}
	}
	sort.SliceStable(idx, func(i, j int) bool {
		a, _ := strconv.ParseUint(idx[i], 10, 64)
		b, _ := strconv.ParseUint(idx[j], 10, 64)
		return a < b
	})
	return append(idx, rest...)
}

// arrayIndex is whether k is a canonical array index (0 to 2^32-2), which JavaScript orders before other keys.
func arrayIndex(k string) bool {
	if k == "" || len(k) > 10 || (len(k) > 1 && k[0] == '0') {
		return false
	}
	for _, c := range k {
		if c < '0' || c > '9' {
			return false
		}
	}
	n, err := strconv.ParseUint(k, 10, 64)
	return err == nil && n < math.MaxUint32
}

// Truthy is JavaScript's truthiness of a parsed value: false for null, false, 0, NaN and "", true otherwise.
func Truthy(v Value) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case int:
		return x != 0
	case string:
		return x != ""
	}
	return true
}

// Parse reads one JSON document as JSON.parse does.
func Parse(data []byte) (Value, error) {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	v, err := parseValue(d)
	if err != nil {
		return nil, err
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, errors.New("jsjson: trailing data after the JSON value")
	}
	return v, nil
}

func parseValue(d *json.Decoder) (Value, error) {
	t, err := d.Token()
	if err != nil {
		return nil, err
	}
	switch x := t.(type) {
	case json.Delim:
		switch x {
		case '{':
			o := NewObject()
			for d.More() {
				kt, err := d.Token()
				if err != nil {
					return nil, err
				}
				v, err := parseValue(d)
				if err != nil {
					return nil, err
				}
				o.Set(kt.(string), v)
			}
			_, err := d.Token()
			return o, err
		case '[':
			a := []Value{}
			for d.More() {
				v, err := parseValue(d)
				if err != nil {
					return nil, err
				}
				a = append(a, v)
			}
			_, err := d.Token()
			return a, err
		}
		return nil, fmt.Errorf("jsjson: unexpected %v", x)
	case json.Number:
		f, err := strconv.ParseFloat(string(x), 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return nil, err
		}
		return f, nil
	default:
		return x, nil // nil, bool or string
	}
}

// Stringify prints v as JSON.stringify(v, null, indent) does; indent "" prints it compact.
func Stringify(v Value, indent string) string {
	var b strings.Builder
	write(&b, v, indent, "")
	return b.String()
}

func write(b *strings.Builder, v Value, indent, prefix string) {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		b.WriteString(strconv.FormatBool(x))
	case float64:
		b.WriteString(Number(x))
	case int:
		b.WriteString(strconv.Itoa(x))
	case string:
		Quote(b, x)
	case []string:
		a := make([]Value, len(x))
		for i, s := range x {
			a[i] = s
		}
		write(b, a, indent, prefix)
	case []Value:
		if len(x) == 0 {
			b.WriteString("[]")
			return
		}
		inner := prefix + indent
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			newline(b, indent, inner)
			write(b, e, indent, inner)
		}
		newline(b, indent, prefix)
		b.WriteByte(']')
	case *Object:
		keys := x.Keys()
		if len(keys) == 0 {
			b.WriteString("{}")
			return
		}
		inner := prefix + indent
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			newline(b, indent, inner)
			Quote(b, k)
			b.WriteByte(':')
			if indent != "" {
				b.WriteByte(' ')
			}
			write(b, x.vals[k], indent, inner)
		}
		newline(b, indent, prefix)
		b.WriteByte('}')
	default:
		panic(fmt.Sprintf("jsjson: cannot print %T", v))
	}
}

func newline(b *strings.Builder, indent, prefix string) {
	if indent != "" {
		b.WriteByte('\n')
		b.WriteString(prefix)
	}
}

// Quote writes s as JSON.stringify quotes a string: `"` and `\` escaped, \b \f \n \r \t by name, other control
// characters as \u00xx, everything else as it is. Invalid UTF-8 (which a JavaScript string can't hold) prints as
// U+FFFD.
func Quote(b *strings.Builder, s string) {
	b.WriteByte('"')
	for i := 0; i < len(s); {
		r, n := utf8.DecodeRuneInString(s[i:])
		i += n
		switch {
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r == '\b':
			b.WriteString(`\b`)
		case r == '\f':
			b.WriteString(`\f`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case r < 0x20:
			fmt.Fprintf(b, `\u%04x`, r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
}

// Number prints f as JavaScript's Number#toString does inside JSON.stringify (NaN and the infinities as null).
func Number(f float64) string {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return "null"
	}
	if f == 0 {
		return "0"
	}
	sign := ""
	if f < 0 {
		sign, f = "-", -f
	}
	// The shortest digits that round-trip, and the decimal exponent n with value = 0.digits × 10^n.
	e := strconv.FormatFloat(f, 'e', -1, 64)
	mant, exp, _ := strings.Cut(e, "e")
	digits := strings.Replace(mant, ".", "", 1)
	x, _ := strconv.Atoi(exp)
	k, n := len(digits), x+1
	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}
	es := "+"
	if n-1 < 0 {
		es = "-"
	}
	ex := strconv.Itoa(abs(n - 1))
	if k == 1 {
		return sign + digits + "e" + es + ex
	}
	return sign + digits[:1] + "." + digits[1:] + "e" + es + ex
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// IsSpace is whether r is whitespace to JavaScript's String#trim and regex \s: WhiteSpace (tab, VT, FF, space, NBSP,
// BOM and the Zs category) and LineTerminator (LF, CR, U+2028, U+2029). Unlike unicode.IsSpace, it holds U+FEFF and
// not U+0085.
func IsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// Trim is JavaScript's String#trim.
func Trim(s string) string { return strings.TrimFunc(s, IsSpace) }

// TrimEnd is JavaScript's String#trimEnd, and s.replace(/\s+$/, ”).
func TrimEnd(s string) string { return strings.TrimRightFunc(s, IsSpace) }
