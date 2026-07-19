const fs=require("fs");
const db=require("better-sqlite3")("/home/iszzu/marveen/store/claudeclaw.db");
const content=fs.readFileSync("/tmp/qq-r1-comment.txt","utf8");
const max=db.prepare("SELECT COALESCE(MAX(id),0) m FROM kanban_comments").get().m;
const now=Math.floor(Date.now()/1000);
db.prepare("INSERT INTO kanban_comments (id, card_id, author, content, created_at) VALUES (?,?,?,?,?)").run(max+1,"a08c1f22","uxuidesigner",content,now);
console.log("comment inserted id", max+1);
