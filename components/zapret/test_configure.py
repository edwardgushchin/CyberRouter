from configure import configure

tls = '--filter-tcp=443 --filter-l7=tls --payload=tls_client_hello --lua-desync=fake --new\n'
protected = '--filter-tcp=8443 --filter-l7=tls --ipset-ip=192.0.2.1 --payload=tls_client_hello --lua-desync=fake --new\n'
discord = '--filter-tcp=2053,2083,2087,2096,8443 --filter-l7=tls --hostlist-domains=discord.media --payload=tls_client_hello --lua-desync=fake:blob=tls_google:tcp_ts=-1000:repeats=6 --new\n'
source = 'NFQWS2_OPT="\n' + protected + tls * 4 + discord + '"\n'
result = configure(source)
assert result.count('--lua-desync=cyberguard') == 5
assert protected in result
assert configure(result) == result
assert result.count('--in-range=x --out-range=a --lua-desync=fake') == 5
assert '--filter-tcp=443,2053,2083,2087,2096,8443' in result
assert '--lua-desync=multisplit:pos=1:seqovl=681:seqovl_pattern=tls_google' in result
for bad in (source.replace(tls, '', 1), source.replace('--payload=', '--in-range=x --payload=', 1+5)):
    try:
        configure(bad)
    except ValueError:
        continue
    raise AssertionError('Unrecognized layout accepted')
print('PASS guard config: five strategies, original filters restored, endpoint untouched, idempotent, unfamiliar layout rejected')
