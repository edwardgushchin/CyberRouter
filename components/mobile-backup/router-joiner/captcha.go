package main

import (
	"bytes"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

var captchaMu sync.Mutex
var captchaServer *http.Server

func closeCaptcha() {
	captchaMu.Lock(); defer captchaMu.Unlock()
	if captchaServer != nil { _ = captchaServer.Close(); captchaServer = nil }
}

// VK's built-in captcha UI is loopback-only. Temporarily expose it solely to
// the same workstation which is allowed to administer this router by SSH.
func serveCaptcha(port string) {
	closeCaptcha()
	localOrigin := "http://127.0.0.1:" + port
	const browserOrigin = "http://10.0.0.1:10982"
	target, err := url.Parse(localOrigin)
	if err != nil { return }
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = &http.Transport{DisableCompression: true}
	proxy.ErrorLog = log.New(io.Discard, "", 0)
	proxy.ModifyResponse = func(r *http.Response) error {
		r.Header.Set("Cache-Control", "no-store")
		if location := r.Header.Get("Location"); location != "" { r.Header.Set("Location", strings.ReplaceAll(location, localOrigin, browserOrigin)) }
		ct := r.Header.Get("Content-Type")
		if !strings.Contains(ct, "html") && !strings.Contains(ct, "javascript") && !strings.Contains(ct, "json") { return nil }
		body, err := io.ReadAll(io.LimitReader(r.Body, 8<<20)); r.Body.Close()
		if err != nil { return err }
		body = bytes.ReplaceAll(body, []byte(localOrigin), []byte(browserOrigin))
		r.Body = io.NopCloser(bytes.NewReader(body)); r.ContentLength = int64(len(body))
		r.Header.Set("Content-Length", strconv.Itoa(len(body)))
		return nil
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		origin := r.Header.Get("Origin")
		if host != "10.0.0.10" || r.Host != "10.0.0.1:10982" || (origin != "" && origin != browserOrigin) {
			http.Error(w, "Forbidden", http.StatusForbidden); return
		}
		r.Header.Del("Accept-Encoding")
		proxy.ServeHTTP(w, r)
	})
	server := &http.Server{Addr:"10.0.0.1:10982", Handler:handler, ReadHeaderTimeout:5*time.Second, IdleTimeout:30*time.Second, ErrorLog:log.New(io.Discard,"",0)}
	captchaMu.Lock(); captchaServer = server; captchaMu.Unlock()
	go func() { _ = server.ListenAndServe() }()
}
