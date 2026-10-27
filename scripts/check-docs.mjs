import {execFileSync} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
import {dirname,resolve,extname} from 'node:path';

const files=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{encoding:'utf8'}).split('\0').filter(name=>name.endsWith('.md'));
function anchors(text) {
  const seen=new Map(),result=new Set();let fenced=false;
  for(const line of text.split('\n')){
    if(/^\s*```/.test(line)){fenced=!fenced;continue;}
    if(fenced||!/^#{1,6} /.test(line))continue;
    const base=line.replace(/^#+\s*/,'').toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu,'').replace(/ /g,'-');
    const count=seen.get(base)??0;seen.set(base,count+1);result.add(base+(count?`-${count}`:''));
  }
  return result;
}
let links=0;
for(const file of new Set(files)){
  const text=readFileSync(file,'utf8');
  if(text.split('\n').filter(line=>/^\s*```/.test(line)).length%2)throw Error(`Unbalanced code fence: ${file}`);
  const prose=text.replace(/^\s*```[^\n]*\n[\s\S]*?^\s*```/gm,'');
  for(const match of prose.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g)){
    const url=match[1];if(/^[a-z][a-z\d+.-]*:/i.test(url)||url.startsWith('//'))continue;
    const [path,anchor]=url.split('#'),target=resolve(dirname(file),decodeURIComponent(path)||file.split('/').at(-1));
    if(!existsSync(target))throw Error(`Broken local link: ${file}: ${url}`);
    if(anchor&&extname(target)==='.md'&&!anchors(readFileSync(target,'utf8')).has(decodeURIComponent(anchor)))throw Error(`Broken anchor: ${file}: ${url}`);
    links++;
  }
}
console.log(`Documentation checks passed: ${new Set(files).size} Markdown files, ${links} local links.`);
