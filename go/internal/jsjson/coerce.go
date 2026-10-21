package jsjson

import (
	"math"
	"strconv"
	"strings"
)

// JavaScript's String(v) and Number(v) for a parsed JSON value.

// ToString is String(v).
func ToString(v Value) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return Number(x)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e != nil {
				parts[i] = ToString(e)
			}
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}

// ToNumber is Number(v); NaN for what is not a number.
func ToNumber(v Value) float64 {
	switch x := v.(type) {
	case nil:
		return 0
	case float64:
		return x
	case bool:
		if x {
			return 1
		}
		return 0
	case string:
		t := Trim(x)
		if t == "" {
			return 0
		}
		// 0x, 0o and 0b integers: Number("0x10") is 16 (a sign is not allowed with them).
		if len(t) > 2 && t[0] == '0' && strings.ContainsRune("xXoObB", rune(t[1])) {
			base := map[byte]int{'x': 16, 'X': 16, 'o': 8, 'O': 8, 'b': 2, 'B': 2}[t[1]]
			if n, err := strconv.ParseUint(t[2:], base, 64); err == nil {
				return float64(n)
			}
			return math.NaN()
		}
		if f, err := strconv.ParseFloat(t, 64); err == nil && !strings.ContainsAny(t, "_xXpP") && !strings.EqualFold(strings.TrimLeft(t, "+-"), "inf") && !strings.EqualFold(strings.TrimLeft(t, "+-"), "infinity") && !strings.EqualFold(strings.TrimLeft(t, "+-"), "nan") {
			return f
		}
		if t == "Infinity" || t == "+Infinity" {
			return math.Inf(1)
		}
		if t == "-Infinity" {
			return math.Inf(-1)
		}
		return math.NaN()
	case []any:
		if len(x) == 0 {
			return 0
		}
		if len(x) == 1 {
			return ToNumber(ToString(x[0]))
		}
	}
	return math.NaN()
}
