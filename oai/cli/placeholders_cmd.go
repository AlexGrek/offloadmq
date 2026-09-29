package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"slices"
	"strings"
	"text/tabwriter"
)

// Custom prompt placeholder management — wraps routes/prompt_placeholders.rs, the
// same CRUD the web UI's Prompt Placeholders page uses. Definitions are per user;
// the server validates names (charset, 64 chars, not reserved, unique
// case-insensitively) and trims/drops empty variants.

const placeholdersUsage = "usage: oai image placeholders <list|show|create|set|add|remove|rename|edit|delete|expand> ..."

// placeholderRequest mirrors PlaceholderRequest: create and update both send the
// full definition.
type placeholderRequest struct {
	Name     string   `json:"name"`
	Variants []string `json:"variants"`
}

func cmdImagePlaceholders(args []string) error {
	if len(args) == 0 {
		return errors.New(placeholdersUsage)
	}
	switch args[0] {
	case "list", "ls":
		return cmdPlaceholdersList(args[1:])
	case "show":
		return cmdPlaceholdersShow(args[1:])
	case "create":
		return cmdPlaceholdersCreate(args[1:])
	case "set":
		return cmdPlaceholdersSet(args[1:])
	case "add":
		return cmdPlaceholdersAdd(args[1:])
	case "remove", "rm":
		return cmdPlaceholdersRemove(args[1:])
	case "rename":
		return cmdPlaceholdersRename(args[1:])
	case "edit":
		return cmdPlaceholdersEdit(args[1:])
	case "delete":
		return cmdPlaceholdersDelete(args[1:])
	case "expand":
		return cmdPlaceholdersExpand(args[1:])
	default:
		return fmt.Errorf("unknown placeholders command %q (%s)", args[0], strings.TrimPrefix(placeholdersUsage, "usage: "))
	}
}

func placeholdersURL(cfg *Config) string {
	return cfg.serverURL("") + "/api/prompt-placeholders"
}

func fetchPlaceholders(cfg *Config) ([]promptPlaceholder, error) {
	var items []promptPlaceholder
	err := doJSON("GET", placeholdersURL(cfg), cfg.Token, nil, &items)
	return items, err
}

func createPlaceholder(cfg *Config, name string, variants []string) (promptPlaceholder, error) {
	var item promptPlaceholder
	err := doJSON("POST", placeholdersURL(cfg), cfg.Token, placeholderRequest{Name: name, Variants: variants}, &item)
	return item, err
}

func updatePlaceholder(cfg *Config, id, name string, variants []string) (promptPlaceholder, error) {
	var item promptPlaceholder
	u := placeholdersURL(cfg) + "/" + url.PathEscape(id)
	err := doJSON("PATCH", u, cfg.Token, placeholderRequest{Name: name, Variants: variants}, &item)
	return item, err
}

// bareName strips optional braces so `create {mood} ...` stores `mood`.
func bareName(ref string) string {
	ref = strings.TrimSpace(ref)
	if strings.HasPrefix(ref, "{") && strings.HasSuffix(ref, "}") {
		ref = strings.TrimSpace(ref[1 : len(ref)-1])
	}
	return ref
}

// placeholderKey normalizes a user-typed name: `{.cinematic}` and `.Cinematic`
// both address the `.cinematic` placeholder (names are unique case-insensitively).
func placeholderKey(ref string) string {
	return strings.ToLower(bareName(ref))
}

// findPlaceholder resolves a name (case-insensitive, braces optional) or an ID.
func findPlaceholder(items []promptPlaceholder, ref string) (promptPlaceholder, bool) {
	key := placeholderKey(ref)
	for _, p := range items {
		if strings.ToLower(strings.TrimSpace(p.Name)) == key {
			return p, true
		}
	}
	for _, p := range items {
		if p.ID == strings.TrimSpace(ref) {
			return p, true
		}
	}
	return promptPlaceholder{}, false
}

func lookupPlaceholder(cfg *Config, ref string) (promptPlaceholder, error) {
	items, err := fetchPlaceholders(cfg)
	if err != nil {
		return promptPlaceholder{}, err
	}
	p, ok := findPlaceholder(items, ref)
	if !ok {
		return promptPlaceholder{}, fmt.Errorf("no custom placeholder named {%s} (see oai image placeholders list)", placeholderKey(ref))
	}
	return p, nil
}

// variantLines splits text into variants the way the web UI's textarea does:
// one per line, trimmed, blank lines dropped.
func variantLines(text string) []string {
	var out []string
	for _, line := range strings.Split(text, "\n") {
		if v := strings.TrimSpace(line); v != "" {
			out = append(out, v)
		}
	}
	return out
}

// variantArgs takes variants from positionals, one per argument; a lone "-"
// reads them from stdin, one per line.
func variantArgs(words []string) ([]string, error) {
	if len(words) == 1 && words[0] == "-" {
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			return nil, err
		}
		return variantLines(string(data)), nil
	}
	var out []string
	for _, w := range words {
		if v := strings.TrimSpace(w); v != "" {
			out = append(out, v)
		}
	}
	return out, nil
}

func cmdPlaceholdersList(args []string) error {
	fs := flag.NewFlagSet("image placeholders list", flag.ContinueOnError)
	full := fs.Bool("full", false, "print every variant instead of a one-line table")
	asJSON := fs.Bool("json", false, "print the raw JSON list")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 0 {
		return errors.New("usage: oai image placeholders list [-full] [-json]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	items, err := fetchPlaceholders(cfg)
	if err != nil {
		return err
	}
	if *asJSON {
		if items == nil {
			items = []promptPlaceholder{}
		}
		return printJSON(&items)
	}
	if len(items) == 0 {
		fmt.Println("No custom placeholders. Create one with: oai image placeholders create NAME \"variant\" ...")
		return nil
	}
	if *full {
		for i, p := range items {
			if i > 0 {
				fmt.Println()
			}
			fmt.Printf("{%s}  %s\n", p.Name, p.ID)
			for _, v := range p.Variants {
				fmt.Printf("  %s\n", v)
			}
		}
		return nil
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "NAME\tID\tVARIANTS\tFIRST")
	for _, p := range items {
		first := ""
		if len(p.Variants) > 0 {
			first = promptOneLine(p.Variants[0], 60)
		}
		fmt.Fprintf(w, "{%s}\t%s\t%d\t%s\n", p.Name, p.ID, len(p.Variants), first)
	}
	return w.Flush()
}

// cmdPlaceholdersShow prints the variants one per line — bare on stdout, the same
// format `set NAME -` reads back.
func cmdPlaceholdersShow(args []string) error {
	fs := flag.NewFlagSet("image placeholders show", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print the placeholder JSON ({id, name, variants})")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return errors.New("usage: oai image placeholders show <name|id> [-json]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	p, err := lookupPlaceholder(cfg, rest[0])
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(&p)
	}
	for _, v := range p.Variants {
		fmt.Println(v)
	}
	return nil
}

func cmdPlaceholdersCreate(args []string) error {
	fs := flag.NewFlagSet("image placeholders create", flag.ContinueOnError)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) < 2 {
		return errors.New(`usage: oai image placeholders create <name> "variant" ["variant" ...]   (or - to read one per line from stdin)`)
	}
	variants, err := variantArgs(rest[1:])
	if err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	item, err := createPlaceholder(cfg, bareName(rest[0]), variants)
	if err != nil {
		return err
	}
	fmt.Printf("Created {%s} with %d variant(s)\n", item.Name, len(item.Variants))
	return nil
}

// cmdPlaceholdersSet replaces every variant of a placeholder, creating it when it
// does not exist yet — the idempotent form for scripts.
func cmdPlaceholdersSet(args []string) error {
	fs := flag.NewFlagSet("image placeholders set", flag.ContinueOnError)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) < 2 {
		return errors.New(`usage: oai image placeholders set <name|id> "variant" ["variant" ...]   (or - to read one per line from stdin)`)
	}
	variants, err := variantArgs(rest[1:])
	if err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	items, err := fetchPlaceholders(cfg)
	if err != nil {
		return err
	}
	var item promptPlaceholder
	verb := "Updated"
	if p, ok := findPlaceholder(items, rest[0]); ok {
		item, err = updatePlaceholder(cfg, p.ID, p.Name, variants)
	} else {
		verb = "Created"
		item, err = createPlaceholder(cfg, bareName(rest[0]), variants)
	}
	if err != nil {
		return err
	}
	fmt.Printf("%s {%s} with %d variant(s)\n", verb, item.Name, len(item.Variants))
	return nil
}

// cmdPlaceholdersAdd appends variants, skipping ones already present.
func cmdPlaceholdersAdd(args []string) error {
	fs := flag.NewFlagSet("image placeholders add", flag.ContinueOnError)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) < 2 {
		return errors.New(`usage: oai image placeholders add <name|id> "variant" ["variant" ...]   (or - for stdin)`)
	}
	added, err := variantArgs(rest[1:])
	if err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	p, err := lookupPlaceholder(cfg, rest[0])
	if err != nil {
		return err
	}
	variants := slices.Clone(p.Variants)
	n := 0
	for _, v := range added {
		if !slices.Contains(variants, v) {
			variants = append(variants, v)
			n++
		}
	}
	if n == 0 {
		fmt.Printf("{%s} already has those variants\n", p.Name)
		return nil
	}
	item, err := updatePlaceholder(cfg, p.ID, p.Name, variants)
	if err != nil {
		return err
	}
	fmt.Printf("Added %d variant(s) to {%s} (%d total)\n", n, item.Name, len(item.Variants))
	return nil
}

// cmdPlaceholdersRemove drops variants by exact (trimmed) text.
func cmdPlaceholdersRemove(args []string) error {
	fs := flag.NewFlagSet("image placeholders remove", flag.ContinueOnError)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) < 2 {
		return errors.New(`usage: oai image placeholders remove <name|id> "variant" ["variant" ...]`)
	}
	drop, err := variantArgs(rest[1:])
	if err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	p, err := lookupPlaceholder(cfg, rest[0])
	if err != nil {
		return err
	}
	var missing []string
	for _, v := range drop {
		if !slices.Contains(p.Variants, v) {
			missing = append(missing, fmt.Sprintf("%q", v))
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("{%s} has no variant %s (see oai image placeholders show %s)", p.Name, strings.Join(missing, ", "), p.Name)
	}
	variants := slices.DeleteFunc(slices.Clone(p.Variants), func(v string) bool { return slices.Contains(drop, v) })
	if len(variants) == 0 {
		return fmt.Errorf("that would leave {%s} with no variants; use oai image placeholders delete %s", p.Name, p.Name)
	}
	item, err := updatePlaceholder(cfg, p.ID, p.Name, variants)
	if err != nil {
		return err
	}
	fmt.Printf("Removed %d variant(s) from {%s} (%d left)\n", len(p.Variants)-len(item.Variants), item.Name, len(item.Variants))
	return nil
}

func cmdPlaceholdersRename(args []string) error {
	fs := flag.NewFlagSet("image placeholders rename", flag.ContinueOnError)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 2 {
		return errors.New("usage: oai image placeholders rename <name|id> <new-name>")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	p, err := lookupPlaceholder(cfg, rest[0])
	if err != nil {
		return err
	}
	item, err := updatePlaceholder(cfg, p.ID, bareName(rest[1]), p.Variants)
	if err != nil {
		return err
	}
	fmt.Printf("Renamed {%s} to {%s} (prompts that use {%s} are not rewritten)\n", p.Name, item.Name, p.Name)
	return nil
}

// cmdPlaceholdersEdit opens the variants (one per line, as in the web UI's
// textarea) in $VISUAL / $EDITOR and saves the result. A name that does not
// exist yet starts from an empty file and is created on save.
func cmdPlaceholdersEdit(args []string) error {
	fs := flag.NewFlagSet("image placeholders edit", flag.ContinueOnError)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return errors.New("usage: oai image placeholders edit <name|id>   (opens $VISUAL / $EDITOR, one variant per line)")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	items, err := fetchPlaceholders(cfg)
	if err != nil {
		return err
	}
	p, exists := findPlaceholder(items, rest[0])
	if !exists {
		p.Name = bareName(rest[0])
	}
	edited, err := editText(p.Name, strings.Join(p.Variants, "\n"))
	if err != nil {
		return err
	}
	variants := variantLines(edited)
	if len(variants) == 0 {
		if exists {
			return fmt.Errorf("no variants left; nothing saved (to remove {%s}, use oai image placeholders delete %s)", p.Name, p.Name)
		}
		return errors.New("no variants entered; nothing created")
	}
	if exists && slices.Equal(variants, p.Variants) {
		fmt.Printf("No changes to {%s}\n", p.Name)
		return nil
	}
	var item promptPlaceholder
	verb := "Updated"
	if exists {
		item, err = updatePlaceholder(cfg, p.ID, p.Name, variants)
	} else {
		verb = "Created"
		item, err = createPlaceholder(cfg, p.Name, variants)
	}
	if err != nil {
		return err
	}
	fmt.Printf("%s {%s} with %d variant(s)\n", verb, item.Name, len(item.Variants))
	return nil
}

// editorCommand returns the user's editor command line; swapped out by tests.
var editorCommand = func() string {
	for _, env := range []string{"VISUAL", "EDITOR"} {
		if v := strings.TrimSpace(os.Getenv(env)); v != "" {
			return v
		}
	}
	return "vi"
}

// editText writes text to a temp file, runs the editor on it, and returns the
// saved contents.
func editText(name, text string) (string, error) {
	f, err := os.CreateTemp("", "oai-placeholder-*.txt")
	if err != nil {
		return "", err
	}
	path := f.Name()
	defer os.Remove(path)
	if text != "" {
		text += "\n"
	}
	if _, err := f.WriteString(text); err != nil {
		f.Close()
		return "", err
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	editor := editorCommand()
	fmt.Fprintf(os.Stderr, "Editing {%s} in %s — one variant per line, blank lines are ignored.\n", name, editor)
	// Like git, let the shell parse $EDITOR so values such as `code -w` or
	// quoted paths work; Windows has no sh, so split on whitespace there.
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		fields := strings.Fields(editor)
		cmd = exec.Command(fields[0], append(fields[1:], path)...)
	} else {
		cmd = exec.Command("sh", "-c", editor+` "$@"`, "sh", path)
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("editor %s: %w (nothing saved)", editor, err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func cmdPlaceholdersDelete(args []string) error {
	fs := flag.NewFlagSet("image placeholders delete", flag.ContinueOnError)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) == 0 {
		return errors.New("usage: oai image placeholders delete <name|id> [name|id ...]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	items, err := fetchPlaceholders(cfg)
	if err != nil {
		return err
	}
	for _, ref := range rest {
		p, ok := findPlaceholder(items, ref)
		if !ok {
			return fmt.Errorf("no custom placeholder named {%s}", placeholderKey(ref))
		}
		if err := doJSON("DELETE", placeholdersURL(cfg)+"/"+url.PathEscape(p.ID), cfg.Token, nil, nil); err != nil {
			return fmt.Errorf("delete {%s}: %w", p.Name, err)
		}
		fmt.Printf("Deleted {%s}\n", p.Name)
	}
	return nil
}

// cmdPlaceholdersExpand previews a prompt's expansion without generating
// anything, using the same expander as `image generate` (so -n N never repeats a
// value until a pool is exhausted). {?} stays literal: the server fills it.
func cmdPlaceholdersExpand(args []string) error {
	fs := flag.NewFlagSet("image placeholders expand", flag.ContinueOnError)
	count := fs.Int("n", 1, "number of expansions to print")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) == 0 || *count < 1 {
		return errors.New(`usage: oai image placeholders expand "prompt with {placeholders}" [-n COUNT]   (or - for stdin)`)
	}
	prompt, err := promptContent(rest)
	if err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	items, err := fetchPlaceholders(cfg)
	if err != nil {
		return err
	}
	expander := newPlaceholderExpander(items)
	out := bufio.NewWriter(os.Stdout)
	for i := 0; i < *count; i++ {
		fmt.Fprintln(out, expander.Expand(prompt))
	}
	if err := out.Flush(); err != nil {
		return err
	}
	if u := expander.Unsupported(); len(u) > 0 {
		fmt.Fprintf(os.Stderr, "note: %s left literal (no CLI dictionary)\n", strings.Join(u, ", "))
	}
	return nil
}
