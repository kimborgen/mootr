package jsjson

import (
	"math/big"
	"strings"
)

// ToFixed is p.toFixed(digits) for a non-negative number below 1e21: the exact decimal expansion of the double, rounded half
// up (strconv rounds an exact tie to even, JavaScript up).
func ToFixed(p float64, digits int) string {
	text := new(big.Float).SetFloat64(p).Text('f', 120)
	whole, frac, _ := strings.Cut(text, ".")
	frac = (frac + strings.Repeat("0", digits+1))[:max(len(frac), digits+1)]
	n, _ := new(big.Int).SetString(whole+frac[:digits], 10)
	if frac[digits] >= '5' {
		n.Add(n, big.NewInt(1))
	}
	d := n.String()
	for len(d) < digits+1 {
		d = "0" + d
	}
	return d[:len(d)-digits] + "." + d[len(d)-digits:]
}
