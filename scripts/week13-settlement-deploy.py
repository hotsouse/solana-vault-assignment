import os,sys,json,subprocess,time,urllib.request,hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];os.chdir(ROOT)

RPC='https://api.devnet.solana.com';PROGRAM='Cm1i9GJUXXvZPA1cDeZ62FjCsmz8w8LJXe91drJYWYx9';ADMIN='3jiQ6pVz6xZ4VqmDho41aPUgXFQns5KeorWyEgb3Qdq7';LOADER='BPFLoaderUpgradeab1e11111111111111111111111'
def rpc(method,params=[]):
 req=urllib.request.Request(RPC,data=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode(),headers={'Content-Type':'application/json'})
 d=json.load(urllib.request.urlopen(req,timeout=40))
 if 'error' in d:raise RuntimeError(d['error'])
 return d['result']
assert rpc('getGenesisHash')=='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
artifact=ROOT/'target/deploy/week13-settlement.so';build=json.loads((ROOT/'evidence/week13/settlement/build-artifact.json').read_text());raw=artifact.read_bytes()
assert len(raw)==build['bytes'] and hashlib.sha256(raw).hexdigest()==build['sha256']
assert subprocess.check_output(['solana-keygen','pubkey','target/deploy/week13-settlement-keypair.json'],text=True).strip()==PROGRAM
wallet=os.environ.get('ANCHOR_WALLET',str(Path.home()/'.config/solana/id.json'))
assert subprocess.check_output(['solana','address','--keypair',wallet],text=True).strip()==ADMIN
existing=rpc('getAccountInfo',[PROGRAM,{'encoding':'base64','commitment':'finalized'}])['value']
if existing:raise RuntimeError('Program already exists: inspect finalized deployment; refusing an automatic upgrade')
rent=rpc('getMinimumBalanceForRentExemption',[len(raw)+45]);balance=rpc('getBalance',[ADMIN,{'commitment':'finalized'}])['value']
assert balance>rent+250000000, f'Funding insufficient: balance={balance}, programdata rent={rent}, reserve=250000000'
print(json.dumps({'genesisVerified':True,'program':PROGRAM,'elfBytes':len(raw),'lamports':balance,'programDataRent':rent,'reservedLamports':250000000}),flush=True)
buffer=ROOT/'target/deploy/week13-settlement-buffer-keypair.json'
if not buffer.exists():subprocess.run(['solana-keygen','new','--no-bip39-passphrase','--silent','--outfile',str(buffer)],check=True,stdout=subprocess.DEVNULL)
args=['solana','program','deploy',str(artifact),'--program-id',str(ROOT/'target/deploy/week13-settlement-keypair.json'),'--buffer',str(buffer),'--keypair',wallet,'--upgrade-authority',wallet,'--max-len',str(len(raw)),'--url',RPC,'--commitment','confirmed','--use-tpu-client','--output','json']
with open(ROOT/'.tools/settlement-deploy-private.log','w') as log:r=subprocess.run(args,stdout=log,stderr=subprocess.STDOUT)
(ROOT/'evidence/week13/settlement/deployment-attempt.json').write_text(json.dumps({'exitCode':r.returncode,'program':PROGRAM,'genesisVerified':True,'elfBytes':len(raw),'sha256':build['sha256'],'programDataRent':rent,'walletLamportsBefore':balance,'transport':'TPU','explicitIgnoredBuffer':True},indent=2)+'\n')
if r.returncode:
 print('Deployment command failed. Private local log: .tools/settlement-deploy-private.log. Inspect and resume the same buffer only after diagnosis.',flush=True);sys.exit(r.returncode)
# Recover the actual finalized loader deployment transaction without trusting CLI presentation.
for attempt in range(90):
 signatures=rpc('getSignaturesForAddress',[PROGRAM,{'limit':20,'commitment':'finalized'}])
 for s in signatures:
  if s['err'] is not None:continue
  tx=rpc('getTransaction',[s['signature'],{'commitment':'finalized','encoding':'jsonParsed','maxSupportedTransactionVersion':0}])
  if not tx or tx['meta']['err'] is not None:continue
  if any(ix.get('programId')==LOADER and (ix.get('parsed',{}).get('type') in ['deployWithMaxDataLen','deploy']) for ix in tx['transaction']['message']['instructions']):
   result={'program':PROGRAM,'signature':s['signature'],'slot':s['slot'],'explorer':'https://explorer.solana.com/tx/'+s['signature']+'?cluster=devnet','commitment':'finalized','sha256':build['sha256'],'bytes':len(raw),'maxLen':len(raw),'upgradeAuthority':ADMIN}
   (ROOT/'evidence/week13/settlement/deployment.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2),flush=True);sys.exit(0)
 time.sleep(1)
raise RuntimeError('Deployment CLI succeeded, but finalized deployment receipt still unavailable; do not redeploy')
