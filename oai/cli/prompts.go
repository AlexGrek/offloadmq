package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"
)

// Prompt library buckets used by the image-generation page
// (ImageGenerationPage.tsx: the prompt box and the negative-prompt box).
const (
	imgPromptBucket   = "imggen-prompt"
	imgNegativeBucket = "imggen-negative"
)

const (
	promptKindRecent  = "recent"
	promptKindStarred = "starred"
	// maxPromptQueryLen mirrors MAX_QUERY_LEN in backend/src/db/prompts.rs.
	maxPromptQueryLen = 500
)

// promptEntry mirrors PromptEntryDto in backend/src/routes/prompts.rs.
type promptEntry struct {
	ID             string  `json:"id"`
	Kind           string  `json:"kind"`
	Content        string  `json:"content"`
	CreatedAt      string  `json:"created_at"`
	LastUsedAt     string  `json:"last_used_at"`
	UpdatedAt      string  `json:"updated_at"`
	PreviewVersion *string `json:"preview_version"`
}

// promptPage mirrors PromptPageResponse: one keyset page, newest first.
type promptPage struct {
	Items      []promptEntry `json:"items"`
	NextCursor *string       `json:"next_cursor"`
}

// promptItem mirrors PromptItem, returned by star and record.
type promptItem struct {
	ID      string `json:"id"`
	Content string `json:"content"`
}

func cmdImagePrompts(args []string) error {
	const usage = "usage: oai image prompts <recent|starred|show|star|unstar|record|edit|delete|preview> ..."
	if len(args) == 0 {
		return errors.New(usage)
	}
	switch args[0] {
	case promptKindRecent, promptKindStarred:
		return cmdPromptsList(args[0], args[1:])
	case "show":
		return cmdPromptsShow(args[1:])
	case "star":
		return cmdPromptsStar(args[1:])
	case "unstar":
		return cmdPromptsUnstar(args[1:])
	case "record":
		return cmdPromptsRecord(args[1:])
	case "edit":
		return cmdPromptsEdit(args[1:])
	case "delete":
		return cmdPromptsDelete(args[1:])
	case "preview":
		return cmdPromptsPreview(args[1:])
	default:
		return fmt.Errorf("unknown prompts command %q (%s)", args[0], strings.TrimPrefix(usage, "usage: "))
	}
}

// negativeFlag selects the negative-prompt library instead of the prompt one.
func negativeFlag(fs *flag.FlagSet) *bool {
	return fs.Bool("negative", false, "use the negative-prompt library ("+imgNegativeBucket+") instead of "+imgPromptBucket)
}

func promptBucket(negative bool) string {
	if negative {
		return imgNegativeBucket
	}
	return imgPromptBucket
}

// promptContent joins positional words into the prompt text; a lone "-" reads
// it from stdin so multi-line prompts can be piped in.
func promptContent(words []string) (string, error) {
	if len(words) == 1 && words[0] == "-" {
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			return "", err
		}
		words = []string{string(data)}
	}
	content := strings.TrimSpace(strings.Join(words, " "))
	if content == "" {
		return "", errors.New("prompt text required (pass it as arguments, or - to read stdin)")
	}
	return content, nil
}

func fetchPromptPage(cfg *Config, bucket, kind, query, cursor string, limit int) (promptPage, error) {
	params := url.Values{"kind": {kind}}
	if query != "" {
		params.Set("q", query)
	}
	if cursor != "" {
		params.Set("cursor", cursor)
	}
	if limit > 0 {
		params.Set("limit", strconv.Itoa(limit))
	}
	var page promptPage
	u := cfg.serverURL("") + "/api/prompts/" + url.PathEscape(bucket) + "/entries?" + params.Encode()
	err := doJSON("GET", u, cfg.Token, nil, &page)
	return page, err
}

// fetchAllPrompts walks every page of one list.
func fetchAllPrompts(cfg *Config, bucket, kind, query string) ([]promptEntry, error) {
	var all []promptEntry
	cursor := ""
	for {
		page, err := fetchPromptPage(cfg, bucket, kind, query, cursor, 100)
		if err != nil {
			return nil, err
		}
		all = append(all, page.Items...)
		if page.NextCursor == nil || *page.NextCursor == "" {
			return all, nil
		}
		cursor = *page.NextCursor
	}
}

// findPromptEntry locates an entry by ID across both image libraries (recent
// first, then starred). The backend has no single-entry GET, so it scans the
// lists; recents are capped at 10 per bucket, so this is cheap.
func findPromptEntry(cfg *Config, id string) (promptEntry, string, error) {
	for _, bucket := range []string{imgPromptBucket, imgNegativeBucket} {
		for _, kind := range []string{promptKindRecent, promptKindStarred} {
			entries, err := fetchAllPrompts(cfg, bucket, kind, "")
			if err != nil {
				return promptEntry{}, "", err
			}
			for _, e := range entries {
				if e.ID == id {
					return e, bucket, nil
				}
			}
		}
	}
	return promptEntry{}, "", fmt.Errorf("prompt %s not found in %s or %s", id, imgPromptBucket, imgNegativeBucket)
}

func cmdPromptsList(kind string, args []string) error {
	fs := flag.NewFlagSet("image prompts "+kind, flag.ContinueOnError)
	negative := negativeFlag(fs)
	query := fs.String("q", "", "case-insensitive substring filter (searches the whole library)")
	limit := fs.Int("limit", 0, "page size (server default 40, max 100)")
	cursor := fs.String("cursor", "", "continue from a previous page's next cursor")
	all := fs.Bool("all", false, "fetch every page")
	full := fs.Bool("full", false, "print full prompt text instead of a one-line table")
	asJSON := fs.Bool("json", false, "print the raw page JSON ({items, next_cursor})")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 0 {
		return fmt.Errorf("usage: oai image prompts %s [-negative] [-q TEXT] [-limit N] [-cursor C] [-all] [-full] [-json]", kind)
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	bucket := promptBucket(*negative)
	var page promptPage
	if *all {
		page.Items, err = fetchAllPrompts(cfg, bucket, kind, *query)
	} else {
		page, err = fetchPromptPage(cfg, bucket, kind, *query, *cursor, *limit)
	}
	if err != nil {
		return err
	}
	if *asJSON {
		if page.Items == nil {
			page.Items = []promptEntry{}
		}
		return printJSON(&page)
	}
	if len(page.Items) == 0 && *query != "" {
		fmt.Printf("No %s prompts in %s match %q.\n", kind, bucket, *query)
	} else if len(page.Items) == 0 {
		fmt.Printf("No %s prompts in %s.\n", kind, bucket)
	} else if *full {
		printPromptBlocks(page.Items)
	} else if err := printPromptTable(page.Items); err != nil {
		return err
	}
	if page.NextCursor != nil && *page.NextCursor != "" {
		fmt.Fprintf(os.Stderr, "More: add -cursor %s (or -all)\n", *page.NextCursor)
	}
	return nil
}

// promptTimestamp is the time the web UI shows: last use for recents, last
// edit for favorites.
func promptTimestamp(e promptEntry) string {
	raw := e.UpdatedAt
	if e.Kind == promptKindRecent {
		raw = e.LastUsedAt
	}
	t, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return raw
	}
	return t.Local().Format("2006-01-02 15:04")
}

func promptOneLine(content string, max int) string {
	line := strings.Join(strings.Fields(content), " ")
	runes := []rune(line)
	if len(runes) > max {
		return string(runes[:max-1]) + "…"
	}
	return line
}

func yesNo(b bool) string {
	if b {
		return "yes"
	}
	return "-"
}

func printPromptTable(entries []promptEntry) error {
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tWHEN\tPREVIEW\tPROMPT")
	for _, e := range entries {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", e.ID, promptTimestamp(e), yesNo(e.PreviewVersion != nil), promptOneLine(e.Content, 80))
	}
	return w.Flush()
}

func printPromptBlocks(entries []promptEntry) {
	for i, e := range entries {
		if i > 0 {
			fmt.Println()
		}
		preview := ""
		if e.PreviewVersion != nil {
			preview = "  [preview]"
		}
		fmt.Printf("%s  %s  %s%s\n%s\n", e.ID, e.Kind, promptTimestamp(e), preview, e.Content)
	}
}

// cmdPromptsShow prints one entry's full text — bare on stdout, so it can feed
// `oai image generate "$(oai image prompts show ID)"`.
func cmdPromptsShow(args []string) error {
	fs := flag.NewFlagSet("image prompts show", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print the entry JSON (with kind, timestamps, preview_version)")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return errors.New("usage: oai image prompts show <id> [-json]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	entry, _, err := findPromptEntry(cfg, rest[0])
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(&entry)
	}
	fmt.Println(entry.Content)
	return nil
}

// cmdPromptsStar adds text — or, with -id, an existing entry such as a recent —
// to the favorites. The server dedupes: starring an existing favorite bumps it.
func cmdPromptsStar(args []string) error {
	fs := flag.NewFlagSet("image prompts star", flag.ContinueOnError)
	negative := negativeFlag(fs)
	fromID := fs.String("id", "", "star the text of an existing entry (e.g. a recent) instead")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if (*fromID == "") == (len(rest) == 0) {
		return errors.New(`usage: oai image prompts star "prompt text" [-negative]  |  oai image prompts star -id <entry-id>`)
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	bucket := promptBucket(*negative)
	var content string
	if *fromID != "" {
		entry, entryBucket, err := findPromptEntry(cfg, *fromID)
		if err != nil {
			return err
		}
		content, bucket = entry.Content, entryBucket
	} else if content, err = promptContent(rest); err != nil {
		return err
	}
	item, err := starPrompt(cfg, bucket, content)
	if err != nil {
		return err
	}
	fmt.Printf("Starred %s\n", item.ID)
	return nil
}

func starPrompt(cfg *Config, bucket, content string) (promptItem, error) {
	var item promptItem
	u := cfg.serverURL("") + "/api/prompts/" + url.PathEscape(bucket) + "/star"
	err := doJSON("POST", u, cfg.Token, contentRequest{Content: content}, &item)
	return item, err
}

// cmdPromptsUnstar removes the favorite whose text equals the given text
// (after trimming, as the server stores it).
func cmdPromptsUnstar(args []string) error {
	fs := flag.NewFlagSet("image prompts unstar", flag.ContinueOnError)
	negative := negativeFlag(fs)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) == 0 {
		return errors.New(`usage: oai image prompts unstar "prompt text" [-negative]   (by ID: oai image prompts delete <id>)`)
	}
	content, err := promptContent(rest)
	if err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	bucket := promptBucket(*negative)
	// Narrow server-side when the text fits the search limit; exact match below.
	query := content
	if len(query) > maxPromptQueryLen {
		query = ""
	}
	matches, err := fetchAllPrompts(cfg, bucket, promptKindStarred, query)
	if err != nil {
		return err
	}
	for _, e := range matches {
		if e.Content == content {
			if err := deletePromptEntry(cfg, e.ID); err != nil {
				return err
			}
			fmt.Printf("Unstarred %s\n", e.ID)
			return nil
		}
	}
	return fmt.Errorf("no starred prompt in %s has exactly that text", bucket)
}

// cmdPromptsRecord pushes text onto the recent list, like a web-UI submission
// does (the server keeps the 10 most recent unique prompts per library).
func cmdPromptsRecord(args []string) error {
	fs := flag.NewFlagSet("image prompts record", flag.ContinueOnError)
	negative := negativeFlag(fs)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) == 0 {
		return errors.New(`usage: oai image prompts record "prompt text" [-negative]`)
	}
	content, err := promptContent(rest)
	if err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var item promptItem
	u := cfg.serverURL("") + "/api/prompts/" + url.PathEscape(promptBucket(*negative)) + "/recent"
	if err := doJSON("POST", u, cfg.Token, contentRequest{Content: content}, &item); err != nil {
		return err
	}
	fmt.Printf("Recorded %s\n", item.ID)
	return nil
}

// cmdPromptsEdit replaces an entry's text; the server carries its preview over.
func cmdPromptsEdit(args []string) error {
	fs := flag.NewFlagSet("image prompts edit", flag.ContinueOnError)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) < 2 {
		return errors.New(`usage: oai image prompts edit <id> "new text"   (or - to read stdin)`)
	}
	content, err := promptContent(rest[1:])
	if err != nil {
		return err
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	var entry promptEntry
	u := cfg.serverURL("") + "/api/prompt-entries/" + url.PathEscape(rest[0])
	if err := doJSON("PATCH", u, cfg.Token, contentRequest{Content: content}, &entry); err != nil {
		return err
	}
	fmt.Printf("Updated %s\n", entry.ID)
	return nil
}

func cmdPromptsDelete(args []string) error {
	fs := flag.NewFlagSet("image prompts delete", flag.ContinueOnError)
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) == 0 {
		return errors.New("usage: oai image prompts delete <id> [id ...]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	for _, id := range rest {
		if err := deletePromptEntry(cfg, id); err != nil {
			return fmt.Errorf("delete %s: %w", id, err)
		}
		fmt.Printf("Deleted %s\n", id)
	}
	return nil
}

func deletePromptEntry(cfg *Config, id string) error {
	return doJSON("DELETE", cfg.serverURL("")+"/api/prompt-entries/"+url.PathEscape(id), cfg.Token, nil, nil)
}

// cmdPromptsPreview saves the entry's preview thumbnail: the latest image
// generated from that exact text.
func cmdPromptsPreview(args []string) error {
	fs := flag.NewFlagSet("image prompts preview", flag.ContinueOnError)
	out := fs.String("o", "preview.jpg", "output file")
	rest, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return errors.New("usage: oai image prompts preview <id> [-o preview.jpg]")
	}
	cfg, err := requireLogin()
	if err != nil {
		return err
	}
	u := cfg.serverURL("") + "/api/prompt-entries/" + url.PathEscape(rest[0]) + "/preview"
	if err := downloadFile(u, cfg.Token, *out); err != nil {
		var httpErr *httpError
		if errors.As(err, &httpErr) && httpErr.Status == 404 {
			return fmt.Errorf("prompt %s has no preview (or does not exist)", rest[0])
		}
		return err
	}
	fmt.Printf("Saved %s\n", *out)
	return nil
}
