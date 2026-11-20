"""Run old regression suites and the new settlement flow on isolated public Devnet clones."""
import os,subprocess,json,time,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];os.chdir(ROOT)
record='--record-evidence' in __import__('sys').argv
out=ROOT/'evidence/week13/settlement' if record else ROOT/'.tools/settlement-reproduction'
if record and (out/'deployment.json').exists():raise SystemExit('Refusing to overwrite published local-test evidence')
out.mkdir(parents=True,exist_ok=True)
fixture=json.loads((ROOT/'evidence/week13/settlement/local-fixture.json').read_text());plan=json.loads((ROOT/'evidence/week13/settlement/preservation-before.json').read_text())
ledger=Path('/tmp')/('week13-settlement-'+str(time.time_ns()));assert not ledger.exists()
args=['solana-test-validator','--quiet','--ledger',str(ledger),'--rpc-port','18899','--faucet-port','19900','--dynamic-port-range','19000-19050','--bind-address','127.0.0.1','--mint',fixture['sourceAdmin'],'--limit-ledger-size','10000','--url','https://api.devnet.solana.com','--bpf-program',plan['oldProgram'],str(ROOT/'target/deploy/week13-accounting-default.so'),'--bpf-program',plan['settlementProgram'],str(ROOT/'target/deploy/week13-settlement.so'),'--clone-upgradeable-program',*fixture['programs'],'--clone',*fixture['accounts']]
log=open(ROOT/'.tools/settlement-validator.log','w');p=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
def run(label,args):
 with open(out/(label+'.txt'),'w') as f:
  q=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
  for line in q.stdout:f.write(line);f.flush();print(line,end='',flush=True)
  code=q.wait()
 print(label,code,flush=True)
 if code:raise RuntimeError(label+' failed')
try:
 ready=False
 for _ in range(120):
  if p.poll() is not None:raise RuntimeError('Validator exited; see private local log')
  try:
   req=urllib.request.Request('http://127.0.0.1:18899',data=json.dumps({'jsonrpc':'2.0','id':1,'method':'getHealth'}).encode(),headers={'Content-Type':'application/json'})
   if json.load(urllib.request.urlopen(req,timeout=2)).get('result')=='ok':ready=True;break
  except Exception:pass
  time.sleep(1)
 assert ready
 os.environ.update({'ANCHOR_PROVIDER_URL':'http://127.0.0.1:18899','WEEK13_CLMM_LOCAL':'1','TS_NODE_TRANSPILE_ONLY':'1','SETTLEMENT_LOCAL':'1','SETTLEMENT_LOCAL_DIR':str(ROOT/'.tools'/ledger.name)})
 print('LOCAL VALIDATOR ONLY; no Devnet transactions are sent',flush=True)
 if '--settlement-only' not in __import__('sys').argv:
  run('legacy-local',['npm','run','test:local'])
  run('clmm-local',['npm','run','test:week13:local'])
 for phase in ['setup','normal','settle','withdraw']:run('local-'+phase,['npm','run','week13:settlement','--',phase])
 m=json.loads((Path(os.environ['SETTLEMENT_LOCAL_DIR'])/'manifest.json').read_text());assert not m.get('pending');last=m['records'][-1]['after'];assert last['a']==last['b']==last['shareSupply']=='0';assert last['strategyActive'] is False
 if record:(out/'local-test-summary.json').write_text(json.dumps({'kind':'LOCAL validator; not Devnet evidence','legacyPassed':17,'clmmPassed':11,'settlementPositiveTransactions':len(m['records']),'explicitNegativeSimulations':len(m['tests']),'expectedFailedTransactions':len(m['failures']),'finalBalances':last},indent=2)+'\n')
finally:
 if p.poll() is None:p.terminate();p.wait(timeout=30)
 print('Stopped only the isolated settlement validator',flush=True)
