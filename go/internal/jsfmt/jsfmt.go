// Package jsfmt prints JSON the way Node does, because tests parse what the TS CLI printed (S-2803): Stringify is
// JSON.stringify(value, null, 2) and Inspect is util.inspect (what console.log shows for an object, as `stam daemon
// status` does). Both keep the key order of the reply.
package jsfmt

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Kind is a JSON value's type.
type Kind int

const (
	Null Kind = iota
	Bool
	Number
	String
	Array
	Object
)

// Value is one decoded JSON value, with an object's keys in the order they arrived.
type Value struct {
	Kind Kind
	// Str is a string's text, Num a number's literal as sent, and Bool is true for true.
	Str  string
	Num  string
	Bool bool
	// Items are an array's elements, or an object's values with Keys beside them.
	Items []Value
	Keys  []string
}

// Parse decodes one JSON document.
func Parse(b []byte) (Value, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	v, err := decode(dec)
	if err != nil {
		return Value{}, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return Value{}, errors.New("invalid JSON: trailing data")
	}
	return v, nil
}

func decode(dec *json.Decoder) (Value, error) {
	tok, err := dec.Token()
	if err != nil {
		return Value{}, err
	}
	switch t := tok.(type) {
	case json.Delim:
		if t == '[' {
			v := Value{Kind: Array}
			for dec.More() {
				item, err := decode(dec)
				if err != nil {
					return Value{}, err
				}
				v.Items = append(v.Items, item)
			}
			_, err := dec.Token()
			return v, err
		}
		v := Value{Kind: Object}
		for dec.More() {
			k, err := dec.Token()
			if err != nil {
				return Value{}, err
			}
			item, err := decode(dec)
			if err != nil {
				return Value{}, err
			}
			v.Keys = append(v.Keys, k.(string))
			v.Items = append(v.Items, item)
		}
		_, err := dec.Token()
		return v, err
	case string:
		return Value{Kind: String, Str: t}, nil
	case json.Number:
		return Value{Kind: Number, Num: t.String()}, nil
	case bool:
		return Value{Kind: Bool, Bool: t}, nil
	}
	return Value{Kind: Null}, nil
}

// Get is an object's member, and whether it is there. Duplicate keys: the last wins, as in JS.
func (v Value) Get(key string) (Value, bool) {
	if v.Kind != Object {
		return Value{}, false
	}
	for i := len(v.Keys) - 1; i >= 0; i-- {
		if v.Keys[i] == key {
			return v.Items[i], true
		}
	}
	return Value{}, false
}

// Text is a member as a string: "" when it is absent, null or not a string.
func (v Value) Text(key string) string {
	if m, ok := v.Get(key); ok && m.Kind == String {
		return m.Str
	}
	return ""
}

// Truthy is JS truthiness.
func (v Value) Truthy() bool {
	switch v.Kind {
	case Null:
		return false
	case Bool:
		return v.Bool
	case String:
		return v.Str != ""
	case Number:
		f, err := strconv.ParseFloat(v.Num, 64)
		return err != nil || f != 0
	}
	return true
}

// Stringify is JSON.stringify(v, null, 2).
func Stringify(v Value) string {
	var b strings.Builder
	write(&b, v, "")
	return b.String()
}

func write(b *strings.Builder, v Value, indent string) {
	switch v.Kind {
	case Null:
		b.WriteString("null")
	case Bool:
		b.WriteString(strconv.FormatBool(v.Bool))
	case Number:
		b.WriteString(jsNumber(v.Num, false))
	case String:
		quoteJSON(b, v.Str)
	case Array:
		if len(v.Items) == 0 {
			b.WriteString("[]")
			return
		}
		in := indent + "  "
		b.WriteString("[\n")
		for i, it := range v.Items {
			b.WriteString(in)
			write(b, it, in)
			if i < len(v.Items)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(indent + "]")
	case Object:
		if len(v.Items) == 0 {
			b.WriteString("{}")
			return
		}
		in := indent + "  "
		b.WriteString("{\n")
		for i, it := range v.Items {
			b.WriteString(in)
			quoteJSON(b, v.Keys[i])
			b.WriteString(": ")
			write(b, it, in)
			if i < len(v.Items)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(indent + "}")
	}
}

// jsNumber is how JS prints the number a JSON literal parses to: 1.50 is 1.5, 1e2 is 100, 12345678901234567890 is
// 12345678901234567000, and 1e21 is 1e+21. A negative zero is 0 in JSON.stringify and -0 in util.inspect.
func jsNumber(lit string, inspect bool) string {
	f, err := strconv.ParseFloat(lit, 64)
	if err != nil {
		return lit
	}
	if f == 0 {
		if inspect && strings.HasPrefix(lit, "-") {
			return "-0"
		}
		return "0"
	}
	abs := f
	if abs < 0 {
		abs = -abs
	}
	if abs >= 1e21 || abs < 1e-6 {
		out := strconv.FormatFloat(f, 'e', -1, 64)
		mant, exp, _ := strings.Cut(out, "e")
		sign := exp[:1]
		exp = strings.TrimLeft(exp[1:], "0")
		return mant + "e" + sign + exp
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// Quote is JSON.stringify(s) for a string.
func Quote(s string) string {
	var b strings.Builder
	quoteJSON(&b, s)
	return b.String()
}

// Compact is JSON.stringify(v) with no indent.
func Compact(v Value) string {
	var b strings.Builder
	compact(&b, v)
	return b.String()
}

func compact(b *strings.Builder, v Value) {
	switch v.Kind {
	case Array:
		b.WriteByte('[')
		for i, it := range v.Items {
			if i > 0 {
				b.WriteByte(',')
			}
			compact(b, it)
		}
		b.WriteByte(']')
	case Object:
		b.WriteByte('{')
		for i, it := range v.Items {
			if i > 0 {
				b.WriteByte(',')
			}
			quoteJSON(b, v.Keys[i])
			b.WriteByte(':')
			compact(b, it)
		}
		b.WriteByte('}')
	default:
		write(b, v, "")
	}
}

// quoteJSON is JSON.stringify for a string: only the quote, the backslash and control characters are escaped.
func quoteJSON(b *strings.Builder, s string) {
	const hex = "0123456789abcdef"
	b.WriteByte('"')
	for i := 0; i < len(s); {
		r, n := utf8.DecodeRuneInString(s[i:])
		switch {
		case r == utf8.RuneError && n == 1:
			b.WriteString(`�`)
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case r == '\b':
			b.WriteString(`\b`)
		case r == '\f':
			b.WriteString(`\f`)
		case r < 0x20:
			b.WriteString(`\u00`)
			b.WriteByte(hex[r>>4])
			b.WriteByte(hex[r&15])
		default:
			b.WriteString(s[i : i+n])
		}
		i += n
	}
	b.WriteByte('"')
}

// Inspect is util.inspect(v) with Node's defaults: breakLength 80, compact 3, two-space indent, single-quoted strings
// and unquoted identifier keys. It matches Node for the shapes the CLI prints (the health reply: flat and nested objects,
// short arrays, strings, numbers, booleans, null). Where it differs:
//   - no depth limit: Node prints a value nested more than two levels deep as [Object] or [Array];
//   - arrays of more than six entries aren't grouped into aligned columns, as Node does for numbers and short strings;
//   - arrays and objects of more than 100 entries aren't cut with "... N more items";
//   - a long string isn't split over lines, and numbers print as the reply wrote them (Node would print 1.0 as 1).
func Inspect(v Value) string {
	c := &inspector{depth: -1}
	return c.format(v, 0, 0)
}

type inspector struct {
	// depth is the nesting level of the last object formatted: Node's ctx.currentDepth.
	depth int
}

var identKey = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z_0-9]*$`)

func (c *inspector) format(v Value, level, indentLvl int) string {
	switch v.Kind {
	case Null:
		return "null"
	case Bool:
		return strconv.FormatBool(v.Bool)
	case Number:
		return jsNumber(v.Num, true)
	case String:
		return quoteInspect(v.Str)
	}
	open, closing := "[", "]"
	if v.Kind == Object {
		open, closing = "{", "}"
	}
	if len(v.Items) == 0 {
		return open + closing
	}
	c.depth = level
	out := make([]string, len(v.Items))
	for i, it := range v.Items {
		s := c.format(it, level+1, indentLvl+2)
		if v.Kind == Object {
			k := v.Keys[i]
			if !identKey.MatchString(k) {
				k = quoteInspect(k)
			}
			s = k + ": " + s
		}
		out[i] = s
	}
	// reduceToSingleString: one line when it nests at most 3 deep below here and fits in 80 columns.
	if c.depth-level < 3 {
		total := len(out) + len(out) + indentLvl + len(open) + 10
		for _, s := range out {
			total += len(s)
		}
		oneLine := total <= 80
		for _, s := range out {
			if strings.Contains(s, "\n") {
				oneLine = false
			}
		}
		if oneLine {
			return open + " " + strings.Join(out, ", ") + " " + closing
		}
	}
	pad := strings.Repeat(" ", indentLvl)
	return open + "\n" + pad + "  " + strings.Join(out, ",\n"+pad+"  ") + "\n" + pad + closing
}

// quoteInspect quotes with ' unless the text holds one and no ", and escapes what Node escapes.
func quoteInspect(s string) string {
	q := byte('\'')
	if strings.Contains(s, "'") {
		switch {
		case !strings.Contains(s, `"`):
			q = '"'
		case !strings.Contains(s, "`") && !strings.Contains(s, "${"):
			q = '`'
		}
	}
	var b strings.Builder
	b.WriteByte(q)
	for _, r := range s {
		switch {
		case r == rune(q):
			b.WriteByte('\\')
			b.WriteRune(r)
		case r == '\\':
			b.WriteString(`\\`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case r == '\b':
			b.WriteString(`\b`)
		case r == '\f':
			b.WriteString(`\f`)
		case r == '\v':
			b.WriteString(`\v`)
		case r < 0x20 || r == 0x7f:
			b.WriteString(`\x`)
			b.WriteString(strings.ToUpper(strconv.FormatInt(int64(r)+0x100, 16)[1:]))
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte(q)
	return b.String()
}

// MarshalJSON writes the value as JSON.stringify would, so a Value can be a reply body with its key order kept.
func (v Value) MarshalJSON() ([]byte, error) { return []byte(Compact(v)), nil }

// Str, Int, NumberOf, Null and Object build values.
func StringValue(s string) Value { return Value{Kind: String, Str: s} }
func IntValue(n int64) Value     { return Value{Kind: Number, Num: strconv.FormatInt(n, 10)} }
func NullValue() Value           { return Value{Kind: Null} }
func ArrayValue(items []Value) Value {
	return Value{Kind: Array, Items: items}
}

// Set sets an object's member in place if it is there, else appends it (JS property assignment).
func (v *Value) Set(key string, val Value) {
	for i, k := range v.Keys {
		if k == key {
			v.Items[i] = val
			return
		}
	}
	v.Keys, v.Items = append(v.Keys, key), append(v.Items, val)
}
