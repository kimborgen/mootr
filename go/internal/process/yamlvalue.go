package process

import (
	"errors"
	"io"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"

	"stam/internal/jsjson"
)

// A YAML node as the values the npm `yaml` package gives (src/process-validate.ts `parse`).
//
// yaml.v3 reads YAML 1.1 plain scalars (a date is a timestamp, 1_000 and 0b11 are numbers); `yaml` reads the 1.2 core schema,
// where those are strings. So a plain scalar is resolved here against the core schema's patterns, never by Node.ShortTag.
// Merge keys are not merged by the core schema either: `<<` is an ordinary key, so it is read as one.

type scalarType int

const (
	tString scalarType = iota
	tNull
	tBool
	tNumber
)

var (
	reNull  = regexp.MustCompile(`^(?:~|[Nn]ull|NULL)?$`)
	reBool  = regexp.MustCompile(`^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$`)
	reInt   = regexp.MustCompile(`^[-+]?[0-9]+$`)
	reOct   = regexp.MustCompile(`^0o[0-7]+$`)
	reHex   = regexp.MustCompile(`^0x[0-9a-fA-F]+$`)
	reInf   = regexp.MustCompile(`^[-+]?\.(?:inf|Inf|INF)$`)
	reNaN   = regexp.MustCompile(`^\.(?:nan|NaN|NAN)$`)
	reFloat = regexp.MustCompile(`^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$`)
)

const quotedOrBlock = yaml.SingleQuotedStyle | yaml.DoubleQuotedStyle | yaml.LiteralStyle | yaml.FoldedStyle

// number reads text as a core-schema number (decimal, 0o octal, 0x hex, float, .inf, .nan).
func numberOf(text string) (float64, bool) {
	switch {
	case reOct.MatchString(text), reHex.MatchString(text):
		base := 8
		if text[1] == 'x' {
			base = 16
		}
		i, ok := new(big.Int).SetString(text[2:], base)
		if !ok {
			return 0, false
		}
		f, _ := new(big.Float).SetInt(i).Float64()
		return f, true
	case reInf.MatchString(text):
		if text[0] == '-' {
			return math.Inf(-1), true
		}
		return math.Inf(1), true
	case reNaN.MatchString(text):
		return math.NaN(), true
	case reInt.MatchString(text), reFloat.MatchString(text):
		f, err := strconv.ParseFloat(text, 64)
		// A value out of range is Infinity in JavaScript, and ParseFloat gives that with an error.
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return 0, false
		}
		return f, true
	}
	return 0, false
}

// scalarOf is what a scalar node reads as: its type, and its number or boolean value. An explicit tag wins; a quoted or block
// scalar is a string; a plain one is resolved against the core schema.
func scalarOf(n *yaml.Node) (t scalarType, num float64, b bool) {
	if n.Style&yaml.TaggedStyle != 0 {
		switch n.ShortTag() {
		case "!!null":
			return tNull, 0, false
		case "!!bool":
			if reBool.MatchString(n.Value) {
				return tBool, 0, n.Value[0] == 't' || n.Value[0] == 'T'
			}
		case "!!int", "!!float":
			if f, ok := numberOf(n.Value); ok {
				return tNumber, f, false
			}
		}
		return tString, 0, false
	}
	if n.Style&quotedOrBlock != 0 {
		return tString, 0, false
	}
	switch {
	case reNull.MatchString(n.Value):
		return tNull, 0, false
	case reBool.MatchString(n.Value):
		return tBool, 0, n.Value[0] == 't' || n.Value[0] == 'T'
	}
	if f, ok := numberOf(n.Value); ok {
		return tNumber, f, false
	}
	return tString, 0, false
}

func resolve(n *yaml.Node) *yaml.Node {
	for n != nil && n.Kind == yaml.AliasNode {
		n = n.Alias
	}
	return n
}

func isMapping(n *yaml.Node) bool  { n = resolve(n); return n != nil && n.Kind == yaml.MappingNode }
func isSequence(n *yaml.Node) bool { n = resolve(n); return n != nil && n.Kind == yaml.SequenceNode }

// isNull is whether the node is a null scalar.
func isNull(n *yaml.Node) bool {
	n = resolve(n)
	if n == nil || n.Kind != yaml.ScalarNode {
		return false
	}
	t, _, _ := scalarOf(n)
	return t == tNull
}

// str is the node's text when it is a string scalar.
func str(n *yaml.Node) (string, bool) {
	n = resolve(n)
	if n == nil || n.Kind != yaml.ScalarNode {
		return "", false
	}
	if t, _, _ := scalarOf(n); t != tString {
		return "", false
	}
	return n.Value, true
}

func number(n *yaml.Node) (float64, bool) {
	n = resolve(n)
	if n == nil || n.Kind != yaml.ScalarNode {
		return 0, false
	}
	t, f, _ := scalarOf(n)
	return f, t == tNumber
}

func boolean(n *yaml.Node) (value, ok bool) {
	n = resolve(n)
	if n == nil || n.Kind != yaml.ScalarNode {
		return false, false
	}
	t, _, b := scalarOf(n)
	return b, t == tBool
}

// jsNumber is String(number): Infinity, -Infinity and NaN print as words, not as JSON's null.
func jsNumber(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	}
	return jsjson.Number(f)
}

// jsString is String(v ?? ”): a scalar's text, null and a missing value as ”, a list joined by commas (a null member is
// empty, and a list that contains itself prints nothing where it repeats), a mapping as [object Object].
func jsString(n *yaml.Node) string { return jsStringIn(n, map[*yaml.Node]bool{}) }

func jsStringIn(n *yaml.Node, open map[*yaml.Node]bool) string {
	n = resolve(n)
	if n == nil {
		return ""
	}
	switch n.Kind {
	case yaml.ScalarNode:
		switch t, f, b := scalarOf(n); t {
		case tNull:
			return ""
		case tBool:
			return strconv.FormatBool(b)
		case tNumber:
			return jsNumber(f)
		}
		return n.Value
	case yaml.MappingNode:
		return "[object Object]"
	}
	if open[n] {
		return ""
	}
	open[n] = true
	defer delete(open, n)
	parts := make([]string, len(n.Content))
	for i, e := range n.Content {
		if !isNull(e) {
			parts[i] = jsStringIn(e, open)
		}
	}
	return strings.Join(parts, ",")
}

// keyOf is a mapping key as JavaScript names the property: String() of the scalar's value, so 0x10, 16 and "16" are one key.
// A null key (`~` or an empty one) is "", as `yaml` names it, not "null".
func keyOf(k *yaml.Node) string {
	k = resolve(k)
	if k == nil {
		return ""
	}
	if k.Kind != yaml.ScalarNode {
		return jsString(k)
	}
	return jsString(k)
}

// keyIdentity is what two keys must share to be the same key to the parser (`yaml` compares the scalar values with ===): a
// string "1" and a number 1 differ here, though both name the property "1". ok is false for a key that never equals another
// (a collection, or NaN).
func keyIdentity(k *yaml.Node) (id string, ok bool) {
	if k.Kind != yaml.ScalarNode {
		return "", false
	}
	t, f, _ := scalarOf(k)
	switch t {
	case tNull:
		return "z", true
	case tBool:
		return "b" + keyOf(k), true
	case tNumber:
		if math.IsNaN(f) {
			return "", false
		}
		return "n" + jsNumber(f), true
	}
	return "s" + k.Value, true
}

// get is a mapping's value for a key (the last one, as a JavaScript object keeps), or nil.
func get(m *yaml.Node, key string) *yaml.Node {
	m = resolve(m)
	if m == nil || m.Kind != yaml.MappingNode {
		return nil
	}
	var found *yaml.Node
	for i := 0; i+1 < len(m.Content); i += 2 {
		if keyOf(m.Content[i]) == key {
			found = m.Content[i+1]
		}
	}
	return found
}

// strings are a sequence's string elements, in order; anything else is dropped.
func stringsOf(n *yaml.Node) []string {
	n = resolve(n)
	if n == nil || n.Kind != yaml.SequenceNode {
		return nil
	}
	var out []string
	for _, e := range n.Content {
		if s, ok := str(e); ok {
			out = append(out, s)
		}
	}
	return out
}

// entries are a mapping's keys and values in JavaScript's Object.entries order: integer-like keys first, ascending, then the
// rest in file order; a repeated key keeps the position of its first and the value of its last.
func entries(m *yaml.Node) (keys []string, vals map[string]*yaml.Node) {
	m = resolve(m)
	vals = map[string]*yaml.Node{}
	var ints, rest []string
	for i := 0; i+1 < len(m.Content); i += 2 {
		k := keyOf(m.Content[i])
		if _, seen := vals[k]; !seen {
			if isArrayIndex(k) {
				ints = append(ints, k)
			} else {
				rest = append(rest, k)
			}
		}
		vals[k] = m.Content[i+1]
	}
	for i := 1; i < len(ints); i++ {
		for j := i; j > 0 && indexOf(ints[j]) < indexOf(ints[j-1]); j-- {
			ints[j], ints[j-1] = ints[j-1], ints[j]
		}
	}
	return append(ints, rest...), vals
}

func isArrayIndex(k string) bool {
	n, err := strconv.ParseUint(k, 10, 32)
	return err == nil && n < 4294967295 && strconv.FormatUint(n, 10) == k
}

func indexOf(k string) uint64 { n, _ := strconv.ParseUint(k, 10, 32); return n }

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// dupKey is the first key a mapping repeats anywhere in the document (the `yaml` package refuses it). An alias is not followed:
// the mapping it names was checked where it is written.
func dupKey(n *yaml.Node) (string, bool) {
	if n == nil || n.Kind == yaml.AliasNode {
		return "", false
	}
	if n.Kind == yaml.MappingNode {
		seen := map[string]bool{}
		for i := 0; i+1 < len(n.Content); i += 2 {
			id, ok := keyIdentity(n.Content[i])
			if !ok {
				continue
			}
			if seen[id] {
				return n.Content[i].Value, true
			}
			seen[id] = true
		}
	}
	for _, c := range n.Content {
		if k, ok := dupKey(c); ok {
			return k, true
		}
	}
	return "", false
}

// maxAliasCount is `yaml`'s default cap on how many times anchored values may be re-read.
const maxAliasCount = 100

// maxAliasWork bounds the walk that measures that, so a file built to make the measure slow is refused as well.
const maxAliasWork = 10_000_000

const errAliasCount = "Excessive alias count indicates a resource exhaustion attack"

// aliasBudget is the check `yaml` makes while it turns a document into values (Alias.toJSON): each use of an anchor adds one
// to its count, and the count times the most aliases one read of the anchored value holds may not pass 100. The walk is in
// document order, as that one is. It reads no alias's target twice, so it costs one pass over the document.
func aliasBudget(root *yaml.Node) error {
	type anchored struct{ count, aliasCount int }
	anchors := map[*yaml.Node]*anchored{}
	work := 0
	var width func(n *yaml.Node) int
	width = func(n *yaml.Node) int {
		work++
		switch n.Kind {
		case yaml.AliasNode:
			if d := anchors[n.Alias]; d != nil {
				return d.count * d.aliasCount
			}
			return 0
		case yaml.DocumentNode, yaml.MappingNode, yaml.SequenceNode:
			most := 0
			for _, c := range n.Content {
				if w := width(c); w > most {
					most = w
				}
			}
			return most
		}
		return 1
	}
	var visit func(n *yaml.Node) error
	visit = func(n *yaml.Node) error {
		if work++; work > maxAliasWork {
			return errors.New(errAliasCount)
		}
		if n.Kind == yaml.AliasNode {
			d := anchors[n.Alias]
			if d == nil {
				if err := visit(n.Alias); err != nil {
					return err
				}
				if d = anchors[n.Alias]; d == nil {
					return nil
				}
			}
			d.count++
			if d.aliasCount == 0 {
				d.aliasCount = width(n.Alias)
			}
			if work > maxAliasWork || d.count*d.aliasCount > maxAliasCount {
				return errors.New(errAliasCount)
			}
			return nil
		}
		if n.Anchor != "" {
			anchors[n] = &anchored{count: 1}
		}
		for _, c := range n.Content {
			if err := visit(c); err != nil {
				return err
			}
		}
		return nil
	}
	return visit(root)
}

// errMultipleDocuments is the start of the text `yaml` gives for a second document (it goes on with the position).
const errMultipleDocuments = "Source contains multiple documents; please use YAML.parseAllDocuments()"

// parseDocument reads the one document of a file: ok false with the message of a file that is not valid YAML. An empty file has
// no document (doc.Kind is 0).
func parseDocument(text string) (doc yaml.Node, msg string, ok bool) {
	dec := yaml.NewDecoder(strings.NewReader(text))
	if err := dec.Decode(&doc); err != nil && !errors.Is(err, io.EOF) {
		return doc, strings.TrimPrefix(err.Error(), "yaml: "), false
	}
	var extra yaml.Node
	switch err := dec.Decode(&extra); {
	case err == nil:
		return doc, errMultipleDocuments, false
	case !errors.Is(err, io.EOF):
		return doc, strings.TrimPrefix(err.Error(), "yaml: "), false
	}
	if err := aliasBudget(&doc); err != nil {
		return doc, err.Error(), false
	}
	return doc, "", true
}
