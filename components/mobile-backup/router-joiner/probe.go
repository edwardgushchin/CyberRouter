package main

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"net"
	"time"
	"whitelist-bypass/relay/common"
)

func probeUDP(address string) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil || host != "127.0.0.1" { return errors.New("probe requires loopback SOCKS") }
	s, err := common.NewSocks5Upstream(address, "", "").UDPAssociate(5*time.Second)
	if err != nil { return errors.New("UDP association failed") }
	defer s.Close()
	query := []byte{0,0,1,0,0,1,0,0,0,0,0,0,7,'e','x','a','m','p','l','e',3,'c','o','m',0,0,1,0,1}
	if _, err := rand.Read(query[:2]); err != nil { return err }
	if err := s.SetReadDeadline(time.Now().Add(10*time.Second)); err != nil { return err }
	if err := s.WriteTo(query, "8.8.8.8:53"); err != nil { return errors.New("UDP send failed") }
	buf := make([]byte, 4096)
	n, err := s.Read(buf)
	if err != nil { return errors.New("UDP response timed out") }
	if n < 12 || binary.BigEndian.Uint16(buf[:2]) != binary.BigEndian.Uint16(query[:2]) || buf[2]&128 == 0 || buf[3]&15 != 0 || binary.BigEndian.Uint16(buf[6:8]) == 0 {
		return errors.New("invalid DNS response")
	}
	return nil
}
