'use strict';
// Generates the sample roster files in public/samples/.  Run: npm run sample
const fs = require('node:fs');
const path = require('node:path');
const out = path.join(__dirname, '..', 'public', 'samples');
fs.mkdirSync(out, { recursive: true });

const first = ['Aarav','Ananya','Kabir','Diya','Ishaan','Meera','Reyansh','Saanvi','Vihaan','Tanvi','Aditya','Kavya','Arnav','Riya','Siddharth','Nikita','Omkar','Shruti','Yash','Prachi','Rahul','Sanika','Tejas','Gauri','Pranav','Neha','Chinmay','Rutuja','Dev','Aditi','Joel','Alisha','Clint','Sharon','Ryan','Melissa','Faiz','Zoya','Imran','Sana'];
const last = ['Naik','Kamat','Prabhu','Gaonkar','Shetye','Desai','Fernandes','D\'Souza','Rodrigues','Sawant','Parab','Kerkar','Borkar','Shirodkar','Velip','Gawas','Pai','Bhat','Salgaonkar','Dias','Pereira','Shaikh','Khan','Mhamal','Volvoikar','Lotlikar','Raikar','Chodankar','Tari','Hegde'];
const depts = [['CS', 'Computer Science', ['CS201', 'CS202']], ['MA', 'Mathematics', ['MA201']], ['EC', 'Electronics', ['EC201']]];

const rows = [['roll_no', 'name', 'email', 'course_code', 'department']];
const used = new Set();
for (let i = 1; i <= 2000; i++) {
  const [code, dept, courses] = depts[i % 3];
  const f = first[(i * 7) % first.length], l = last[(i * 13) % last.length];
  const roll = `24${code}${String(i).padStart(4, '0')}`;
  let email = `${f}.${l}`.toLowerCase().replace(/[^a-z.]/g, '') + '@dempo.edu';
  if (used.has(email)) email = email.replace('@', `${i}@`);
  used.add(email);
  const name = `${f} ${l}`;
  rows.push([roll, name.includes(',') || name.includes('"') ? `"${name.replace(/"/g, '""')}"` : name, email, courses[i % courses.length], dept]);
}
fs.writeFileSync(path.join(out, 'students-2000.csv'), rows.map(r => r.join(',')).join('\n') + '\n');

fs.writeFileSync(path.join(out, 'roster-template.csv'),
  'roll_no,name,email,course_code,department\n24CS0001,Neha Kerkar,neha.kerkar@dempo.edu,CS201,Computer Science\n24CS0001,Neha Kerkar,neha.kerkar@dempo.edu,CS202,Computer Science\n');

// One example of every kind of problem the importer handles.
fs.writeFileSync(path.join(out, 'students-with-errors.csv'), [
  'Roll No,Student Name,Email Address,Course Code,Dept,Phone',
  '24CS9001,Ritika Naik,ritika.naik@dempo.edu,CS201,Computer Science,9822000001',
  '24CS9001,Ritika Naik,ritika.naik@dempo.edu,CS202,Computer Science,9822000001',
  '24CS9002,"Fernandes, Liam",liam.f@dempo.edu,cs201,Computer Science,',
  '24CS9003,Owen Dias,owen.dias@dempo,CS201,Computer Science,',
  '24CS9004,,no.name@dempo.edu,CS201,Computer Science,',
  '24CS9005,Tara Sawant,tara.sawant@dempo.edu,CS999,Computer Science,',
  '24CS9001,Ritika Naik,ritika.naik@dempo.edu,CS201,Computer Science,9822000001',
  '24CS9006,Ritika N.,ritika.naik@dempo.edu,MA201,Computer Science,',
  '24CS9007,Arjun Rao,arjun.rao@dempo.edu,CS201,Computer Science,,extra',
  '23CS001,Aisha D\'Souza,aisha.dsouza@dempo.edu,CS201,Computer Science,',
  '23CS001,Aisha D\'Souza,aisha.dsouza@dempo.edu,MA201,Computer Science,',
  '23CS002,Someone Else,someone.else@dempo.edu,CS201,Computer Science,',
  'X!,Bad Roll,bad.roll@dempo.edu,CS201,Computer Science,',
  'ADMIN01,Exam Office,admin@dempo.edu,CS201,Administration,',
].join('\r\n') + '\r\n');
console.log('Wrote samples to public/samples/');
