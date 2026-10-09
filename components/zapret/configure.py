#!/usr/bin/env python3
"""Add the TLS guard to an existing local config; input/output may contain secrets."""
import re
import sys
from pathlib import Path


def configure(source):
    # Flowseal ALT11's Google fake + sequence overlap passed full client downloads
    # where fake-only and plain segmentation stalled. Scope it to Discord TLS.
    lines = source.splitlines(keepends=True)
    for index, line in enumerate(lines):
        if '--hostlist-domains=discord.media ' in line and '--filter-tcp=2053,2083,2087,2096,8443 ' in line:
            fake = '--lua-desync=fake:blob=tls_google:tcp_ts=-1000:repeats=6'
            if line.count(fake) != 1:
                raise ValueError('Unexpected Discord strategy; review before replacement')
            line = line.replace('--filter-tcp=2053,', '--filter-tcp=443,2053,')
            line = line.replace('--hostlist-domains=discord.media ',
                '--hostlist-domains=discord.media,discord.com,discord.gg,discordapp.com,discordapp.net,discordcdn.com,discordstatus.com,dis.gd ')
            lines[index] = line.replace(fake,
                '--lua-desync=fake:blob=tls_google:tcp_ts=-1000:repeats=8 '
                '--lua-desync=multisplit:pos=1:seqovl=681:seqovl_pattern=tls_google')
    source = ''.join(lines)
    if '--lua-desync=cyberguard' in source:
        return source
    count = 0
    lines = []
    for line in source.splitlines(keepends=True):
        if line.startswith('NFQWS2_OPT="'):
            line += '--lua-init=@/opt/zapret2-local/cyberguard.lua --writable=/tmp/zapret-health\n'
        if '--filter-tcp=' in line and '--filter-l7=tls' in line and '--ipset-ip=' not in line:
            if any(option in line for option in ('--in-range=', '--out-range=')):
                raise ValueError('Review existing range filters before adding the guard')
            before = '--payload=tls_client_hello --lua-desync='
            if line.count(before) != 1:
                raise ValueError('Unexpected TLS strategy layout')
            line = line.replace(before,
                '--payload=all --in-range=-n10 --out-range=-n20 --lua-desync=cyberguard '
                '--payload=tls_client_hello --in-range=x --out-range=a --lua-desync=')
            count += 1
        lines.append(line)
    if count != 5 or source.count('NFQWS2_OPT="\n') != 1:
        raise ValueError('Expected five existing TLS strategies and one NFQWS2_OPT block')
    return ''.join(lines)


if __name__ == '__main__':
    # Never print config or exception input: this file can contain protected endpoints.
    source, destination = map(Path, sys.argv[1:])
    value = configure(source.read_text())
    destination.touch(mode=0o600, exist_ok=False)
    destination.write_text(value)
