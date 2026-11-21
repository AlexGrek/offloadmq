package main

import (
	"math/rand/v2"
	"strings"
	"unicode"

	"github.com/brianvoe/gofakeit/v7"
)

// Prompt placeholders, mirroring frontend/src/lib/promptPlaceholders.ts:
//
//   - {color} {animal} {adjective} {country} {language} {name} are expanded here.
//     The web UI draws them from unique-names-generator; gofakeit is the Go
//     analog, so the word pools differ slightly but the behaviour is the same.
//   - {starwars} has no Go equivalent and is left literal (see unsupportedPlaceholders).
//   - {?} is expanded by the server at job creation — it is never touched here.
//   - {random} becomes another placeholder picked at random (a builtin, {?}, or a
//     non-empty custom one) and expands as that. {starwars} is left out of its pool.
//   - Any other {name} is a custom placeholder from the user's server-side
//     definitions (GET /api/prompt-placeholders), shared with the web UI.

// maxPlaceholderDepth caps recursion for custom variants that themselves contain
// placeholders (including cycles); beyond it the remaining tokens stay literal.
const maxPlaceholderDepth = 5

// maxPickAttempts bounds the search for an unused value before the used set is reset.
const maxPickAttempts = 64

func isTokenChar(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '-' || r == '_'
}

func isToken(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if !isTokenChar(r) {
			return false
		}
	}
	return true
}

// matchBraced matches a {...} block starting at text[0] == '{', balancing nested
// {...} pairs. It returns the byte index of the matching '}', any top-level '|'
// choices (at brace depth 1), and whether a closing '}' was found.
func matchBraced(text string) (closeIdx int, choices []string, ok bool) {
	depth := 1
	choiceStart := 1
	for i := 1; i < len(text); i++ {
		switch text[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				if choices != nil {
					choices = append(choices, text[choiceStart:i])
				}
				return i, choices, true
			}
		case '|':
			if depth == 1 {
				choices = append(choices, text[choiceStart:i])
				choiceStart = i + 1
			}
		}
	}
	return 0, nil, false
}

var builtinPlaceholders = map[string]func() string{
	"color":     func() string { return splitCamelCase(gofakeit.Color()) },
	"animal":    gofakeit.Animal,
	"adjective": gofakeit.AdjectiveDescriptive,
	"country":   gofakeit.Country,
	"language":  gofakeit.Language,
	"name":      gofakeit.FirstName,
}

// splitCamelCase turns gofakeit's CSS color names ("MediumVioletRed") into
// words ("Medium Violet Red"); the expander lowercases them afterwards, and
// without this they would collapse into "mediumvioletred".
func splitCamelCase(s string) string {
	var b strings.Builder
	runes := []rune(s)
	for i, r := range runes {
		if i > 0 && unicode.IsUpper(r) && unicode.IsLower(runes[i-1]) {
			b.WriteByte(' ')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// randomPlaceholder expands into a random other placeholder.
const randomPlaceholder = "random"

// unsupportedPlaceholders are reserved by the web UI but have no Go dictionary.
var unsupportedPlaceholders = map[string]bool{"starwars": true}

type promptPlaceholder struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Variants []string `json:"variants"`
}

// placeholderExpander tracks values already handed out per placeholder name so a
// batch never repeats one (until a pool is exhausted).
type placeholderExpander struct {
	custom      map[string][]string // lowercased name -> variants
	used        map[string]map[string]bool
	unsupported map[string]bool // unsupported tokens seen, for a single warning
}

func newPlaceholderExpander(custom []promptPlaceholder) *placeholderExpander {
	defs := make(map[string][]string, len(custom))
	for _, c := range custom {
		defs[strings.ToLower(strings.TrimSpace(c.Name))] = c.Variants
	}
	return &placeholderExpander{
		custom:      defs,
		used:        map[string]map[string]bool{},
		unsupported: map[string]bool{},
	}
}

func (e *placeholderExpander) usedSet(key string) map[string]bool {
	s := e.used[key]
	if s == nil {
		s = map[string]bool{}
		e.used[key] = s
	}
	return s
}

// pick draws a value from next that is not yet in used; if the pool looks
// exhausted it starts a fresh cycle rather than looping forever.
func pick(next func() string, used map[string]bool) string {
	for i := 0; i < maxPickAttempts; i++ {
		if v := next(); !used[v] {
			used[v] = true
			return v
		}
	}
	clear(used)
	v := next()
	used[v] = true
	return v
}

// Expand resolves {category}, custom {name}, and {a|b|c} choices.
// Each choice occurrence is picked independently, preserving case; empty options are allowed
// and the chosen option is expanded for nested placeholders.
func (e *placeholderExpander) Expand(prompt string) string {
	return e.expandLevel(prompt, 0)
}

func (e *placeholderExpander) expandLevel(text string, depth int) string {
	if !strings.Contains(text, "{") || depth >= maxPlaceholderDepth {
		return text
	}
	var out strings.Builder
	out.Grow(len(text))
	rest := text
	for {
		open := strings.IndexByte(rest, '{')
		if open < 0 {
			out.WriteString(rest)
			break
		}
		out.WriteString(rest[:open])
		braced := rest[open:]
		closeIdx, choices, ok := matchBraced(braced)
		if !ok {
			out.WriteByte('{')
			rest = braced[1:]
			continue
		}
		if choices != nil {
			picked := strings.TrimSpace(choices[rand.IntN(len(choices))])
			out.WriteString(e.expandLevel(picked, depth+1))
			rest = braced[closeIdx+1:]
			continue
		}
		raw := braced[1:closeIdx]
		if !isToken(raw) {
			out.WriteByte('{')
			rest = braced[1:]
			continue
		}
		token := strings.ToLower(raw)

		if token == randomPlaceholder {
			name := e.randomName()
			if name == "?" {
				out.WriteString("{?}")
			} else {
				out.WriteString(e.expandLevel("{"+name+"}", depth+1))
			}
			rest = braced[closeIdx+1:]
			continue
		}
		if gen, ok := builtinPlaceholders[token]; ok {
			out.WriteString(strings.ToLower(pick(gen, e.usedSet(token))))
			rest = braced[closeIdx+1:]
			continue
		}
		if variants := e.custom[token]; len(variants) > 0 {
			v := pick(func() string { return variants[rand.IntN(len(variants))] }, e.usedSet(token))
			out.WriteString(e.expandLevel(v, depth+1))
			rest = braced[closeIdx+1:]
			continue
		}
		if unsupportedPlaceholders[token] {
			e.unsupported[token] = true
		}
		// Unknown name (including {?}, expanded server-side) — leave untouched.
		out.WriteString(braced[:closeIdx+1])
		rest = braced[closeIdx+1:]
	}
	return out.String()
}

// randomName picks a builtin, "?", or a non-empty custom placeholder name.
func (e *placeholderExpander) randomName() string {
	pool := []string{"?"}
	for name := range builtinPlaceholders {
		pool = append(pool, name)
	}
	for name, variants := range e.custom {
		if len(variants) > 0 && name != randomPlaceholder {
			pool = append(pool, name)
		}
	}
	return pool[rand.IntN(len(pool))]
}

// Unsupported lists reserved placeholders that were left literal because the CLI has no dictionary for them.
func (e *placeholderExpander) Unsupported() []string {
	var out []string
	for name := range e.unsupported {
		out = append(out, "{"+name+"}")
	}
	return out
}
