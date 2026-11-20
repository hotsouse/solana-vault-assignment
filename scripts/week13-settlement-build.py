"""Build both source identities without upgrading either deployment.
Recording new evidence is explicit and refused after a deployment receipt exists.
"""
from pathlib import Path
import os,sys,json,subprocess,hashlib,shutil
ROOT=Path(__file__).resolve().parents[1];os.chdir(ROOT)
EVIDENCE=ROOT/'evidence/week13/settlement'
plan=json.loads((EVIDENCE/'preservation-before.json').read_text())
record='--record-evidence' in sys.argv
if record and (EVIDENCE/'deployment.json').exists():raise SystemExit('Refusing to overwrite published deployment evidence')
anchor=os.environ.get('ANCHOR_CLI','anchor');assert '0.31.1' in subprocess.check_output([anchor,'--version'],text=True)
os.environ.setdefault('CARGO_BUILD_JOBS','2')
def run(label,args):
 path=(EVIDENCE if record else ROOT/'.tools')/(label+'.txt')
 path.parent.mkdir(parents=True,exist_ok=True)
 with path.open('w') as log:p=subprocess.run(args,stdout=log,stderr=subprocess.STDOUT)
 print(label,p.returncode,flush=True)
 if p.returncode:print(path.read_text()[-6500:],flush=True);raise SystemExit(p.returncode)
run('format-check',['cargo','fmt','--check'])
run('cargo-check',['cargo','check','--workspace'])
run('rust-tests',['cargo','test','--workspace'])
run('anchor-build',[anchor,'build'])
shutil.copyfile('target/deploy/simple_vault.so','target/deploy/week13-accounting-default.so')
default=json.loads(Path('target/idl/simple_vault.json').read_text());default['address']=plan['oldProgram']
run('anchor-build-settlement',[anchor,'build','--','--features','settlement-deployment'])
shutil.copyfile('target/deploy/simple_vault.so','target/deploy/week13-settlement.so')
idl=json.loads(Path('target/idl/simple_vault.json').read_text());idl['address']=plan['settlementProgram']
Path('target/idl/settlement_vault.json').write_text(json.dumps(idl,indent=2)+'\n')
Path('target/idl/simple_vault.json').write_text(json.dumps(default,indent=2)+'\n')
if record:
 raw=Path('target/deploy/week13-settlement.so').read_bytes();idlraw=Path('target/idl/settlement_vault.json').read_bytes()
 (EVIDENCE/'program-idl.json').write_bytes(idlraw)
 result={'program':plan['settlementProgram'],'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'publicIdlSha256':hashlib.sha256(idlraw).hexdigest(),'feature':'settlement-deployment','artifact':'target/deploy/week13-settlement.so','sourceHashes':{str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in (ROOT/'programs/simple_vault/src').glob('*.rs')},'historicalProgramNotUpgraded':True}
 (EVIDENCE/'build-artifact.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2),flush=True)
