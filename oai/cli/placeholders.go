package main

import (
	"math/rand/v2"
	"regexp"
	"strings"

	"github.com/brianvoe/gofakeit/v7"
)

// Prompt placeholders, mirroring frontend/src/lib/promptPlaceholders.ts:
//
//   - {color} {animal} {adjective} {country} {language} {name} are expanded here.
//     The web UI draws them from unique-names-generator; gofakeit is the Go
//     analog, so the word pools differ slightly but the behaviour is the same.
//   - {starwars} has no Go equivalent and is left literal (see unsupportedPlaceholders).
//   - {?} is expanded by the server at job creation — it is never touched here.
//   - Any other {name} is a custom placeholder from the user's server-side
//     definitions (GET /api/prompt-placeholders), shared with the web UI.

// maxPlaceholderDepth caps recursion for custom variants that themselves contain
// placeholders (including cycles); beyond it the remaining tokens stay literal.
const maxPlaceholderDepth = 5

// maxPickAttempts bounds the search for an unused value before the used set is reset.
const maxPickAttempts = 64

var placeholderRE = regexp.MustCompile(`\{([A-Za-z0-9._-]+)\}`)

var builtinPlaceholders = map[string]func() string{
	"color":     gofakeit.Color,
	"animal":    gofakeit.Animal,
	"adjective": gofakeit.AdjectiveDescriptive,
	"country":   gofakeit.Country,
	"language":  gofakeit.Language,
	"name":      gofakeit.FirstName,
}

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

// Expand resolves {category} and custom {name} placeholders in prompt.
func (e *placeholderExpander) Expand(prompt string) string {
	return e.expandLevel(prompt, 0)
}

func (e *placeholderExpander) expandLevel(text string, depth int) string {
	if !strings.Contains(text, "{") || depth >= maxPlaceholderDepth {
		return text
	}
	return placeholderRE.ReplaceAllStringFunc(text, func(match string) string {
		token := strings.ToLower(match[1 : len(match)-1])

		if gen, ok := builtinPlaceholders[token]; ok {
			return strings.ToLower(pick(gen, e.usedSet(token)))
		}
		if variants := e.custom[token]; len(variants) > 0 {
			v := pick(func() string { return variants[rand.IntN(len(variants))] }, e.usedSet(token))
			return e.expandLevel(v, depth+1)
		}
		if unsupportedPlaceholders[token] {
			e.unsupported[token] = true
		}
		// Unknown name (including {?}, expanded server-side) — leave untouched.
		return match
	})
}

// Unsupported lists reserved placeholders that were left literal because the CLI has no dictionary for them.
func (e *placeholderExpander) Unsupported() []string {
	var out []string
	for name := range e.unsupported {
		out = append(out, "{"+name+"}")
	}
	return out
}
