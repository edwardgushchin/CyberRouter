package dion

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"strings"
)

type CookieEntry struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type CookieFile struct {
	Email    string        `json:"email"`
	Password string        `json:"password"`
	Cookies  []CookieEntry `json:"cookies"`
}

func parseCookieFile(raw []byte) (CookieFile, error) {
	var file CookieFile
	if err := json.Unmarshal(raw, &file); err == nil {
		return file, nil
	}
	var entries []CookieEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		return CookieFile{}, fmt.Errorf("parse cookies: %w", err)
	}
	return CookieFile{Cookies: entries}, nil
}

func (s *Session) LoadCookiesFromFile(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read cookies: %w", err)
	}
	file, err := parseCookieFile(raw)
	if err != nil {
		return err
	}
	if err := s.LoadCookies(file.Cookies); err != nil {
		return err
	}
	s.cookiesPath = path
	s.email = strings.TrimSpace(file.Email)
	s.password = file.Password
	s.seedAccessTokenFromCookies(file.Cookies)
	return nil
}

func (s *Session) HasCredentials() bool {
	return s.email != "" && s.password != ""
}

func (s *Session) HasRefreshCookie() bool {
	if s.HTTPClient == nil || s.HTTPClient.Jar == nil {
		return false
	}
	web, err := url.Parse(WebBase)
	if err != nil {
		return false
	}
	for _, c := range s.HTTPClient.Jar.Cookies(web) {
		if c.Name == refreshCookieName && c.Value != "" {
			return true
		}
	}
	return false
}

func (s *Session) seedAccessTokenFromCookies(entries []CookieEntry) {
	for _, entry := range entries {
		if entry.Name != accessCookieName || entry.Value == "" {
			continue
		}
		exp, err := parseJWTExpiry(entry.Value)
		if err != nil {
			return
		}
		s.AccessToken = entry.Value
		s.AccessTokenExp = exp
		return
	}
}

func (s *Session) SaveCookiesToFile(path string) error {
	if s.HTTPClient == nil || s.HTTPClient.Jar == nil {
		return fmt.Errorf("no cookiejar")
	}
	web, err := url.Parse(WebBase)
	if err != nil {
		return fmt.Errorf("parse target %s: %w", WebBase, err)
	}
	seen := make(map[string]string)
	for _, c := range s.HTTPClient.Jar.Cookies(web) {
		seen[c.Name] = c.Value
	}
	if existing, err := os.ReadFile(path); err == nil {
		if prev, err := parseCookieFile(existing); err == nil {
			for _, entry := range prev.Cookies {
				if _, exists := seen[entry.Name]; !exists {
					seen[entry.Name] = entry.Value
				}
			}
		}
	}
	entries := make([]CookieEntry, 0, len(seen))
	for name, value := range seen {
		entries = append(entries, CookieEntry{Name: name, Value: value})
	}
	var raw []byte
	if s.HasCredentials() {
		raw, err = json.MarshalIndent(CookieFile{
			Email:    s.email,
			Password: s.password,
			Cookies:  entries,
		}, "", "  ")
	} else {
		raw, err = json.MarshalIndent(entries, "", "  ")
	}
	if err != nil {
		return fmt.Errorf("marshal cookies: %w", err)
	}
	if atomicErr := writeFileAtomic(path, raw); atomicErr != nil {
		if inPlaceErr := os.WriteFile(path, raw, 0o600); inPlaceErr != nil {
			return fmt.Errorf("write cookies: %v, in-place fallback: %w", atomicErr, inPlaceErr)
		}
	}
	return nil
}

func writeFileAtomic(path string, raw []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return fmt.Errorf("write cookies tmp: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("rename cookies tmp: %w", err)
	}
	return nil
}

func (s *Session) SetCookieInJar(name, value string) {
	if s.HTTPClient == nil || s.HTTPClient.Jar == nil {
		return
	}
	web, err := url.Parse(WebBase)
	if err != nil {
		return
	}
	s.HTTPClient.Jar.SetCookies(web, []*http.Cookie{
		{Name: name, Value: value, Path: "/", Domain: CookieDomain},
	})
}

func (s *Session) LoadCookieString(cookieStr string) error {
	cookieStr = strings.TrimSpace(cookieStr)
	if cookieStr == "" {
		return fmt.Errorf("empty cookie string")
	}
	var entries []CookieEntry
	for _, piece := range strings.Split(cookieStr, ";") {
		piece = strings.TrimSpace(piece)
		if piece == "" {
			continue
		}
		eq := strings.IndexByte(piece, '=')
		if eq <= 0 {
			continue
		}
		entries = append(entries, CookieEntry{Name: piece[:eq], Value: piece[eq+1:]})
	}
	return s.LoadCookies(entries)
}

func (s *Session) LoadCookies(entries []CookieEntry) error {
	if s.HTTPClient.Jar == nil {
		jar, err := cookiejar.New(nil)
		if err != nil {
			return fmt.Errorf("cookiejar: %w", err)
		}
		s.HTTPClient.Jar = jar
	}
	web, err := url.Parse(WebBase)
	if err != nil {
		return fmt.Errorf("parse target %s: %w", WebBase, err)
	}
	cookies := make([]*http.Cookie, 0, len(entries))
	for _, entry := range entries {
		if entry.Name == "" {
			continue
		}
		cookies = append(cookies, &http.Cookie{
			Name:   entry.Name,
			Value:  entry.Value,
			Path:   "/",
			Domain: CookieDomain,
		})
	}
	s.HTTPClient.Jar.SetCookies(web, cookies)
	return nil
}

func (s *Session) PrimeCookies(slug string) error {
	target := WebBase + "/"
	if slug != "" {
		target = fmt.Sprintf("%s/event/%s?showWeb=true", WebBase, slug)
	}
	req, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		return err
	}
	s.setBaseHeaders(req, "")
	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("prime cookies: %w", err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode >= 400 {
		return fmt.Errorf("prime cookies: status %d", resp.StatusCode)
	}
	return nil
}
