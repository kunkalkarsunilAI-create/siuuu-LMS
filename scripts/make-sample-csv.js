'use strict';
// Writes the sample employee files to public/samples/.  Run: npm run sample
const fs = require('node:fs'), path = require('node:path');
const out = path.join(__dirname, '..', 'public', 'samples');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'employees-template.csv'),
  'employee_id,name,email,department,job_title,manager_email,joined_on,status\r\n' +
  'MS-601,Sneha Kamat,sneha.kamat@mandovi.example,Engineering,Software Engineer,rahul.desai@mandovi.example,2026-11-10,active\r\n');
// A realistic HR export with one of each kind of problem the importer handles.
fs.writeFileSync(path.join(out, 'employees-sample.csv'), [
  'Emp Code,Full Name,Work Email,Dept,Designation,Reporting Manager,Date of Joining,Status',
  'MS-601,Sneha Kamat,sneha.kamat@mandovi.example,Engineering,Software Engineer,rahul.desai@mandovi.example,10/11/2026,Active',
  'MS-602,Vivek Shirodkar,vivek.shirodkar@mandovi.example,Operations,Operations Lead,,01/11/2026,Active',
  'MS-603,Alisha Dias,alisha.dias@mandovi.example,Operations,Operations Associate,vivek.shirodkar@mandovi.example,03/11/2026,Active',
  'MS-604,Faiz Mulla,faiz.mulla@mandovi.example,Sales,Account Executive,sonia.fernandes@mandovi.example,12-Nov-2026,Active',
  'MS-203,Meera Borkar,meera.borkar@mandovi.example,Customer Support,Support Specialist,imran.shaikh@mandovi.example,,Active',
  'MS-402,Omkar Velip,omkar.velip@mandovi.example,Finance,Accounts Associate,priya.kamat@mandovi.example,,Left',
  'MS-401,Gauri Parab,gauri.parab@mandovi.example,Finance,Accountant,priya.kamat@mandovi.example,,Active',
  'MS-605,Karan Lotlikar,karan.lotlikar@mandovi,Sales,Sales Development Rep,sonia.fernandes@mandovi.example,05/11/2026,Active',
  'MS-606,Ritu Sawant,ritu.sawant@mandovi.example,Sales,Sales Development Rep,ghost.manager@mandovi.example,05/11/2026,Active',
  'MS-101,Someone Else,someone.else@mandovi.example,Finance,Analyst,,05/11/2026,Active',
  'MS-607,Tina Pinto,tina.pinto@mandovi.example,Finance,Analyst,priya.kamat@mandovi.example,31/02/2026,Active',
  'MS-608,,no.name@mandovi.example,Finance,Analyst,,05/11/2026,Active',
].join('\r\n') + '\r\n');
console.log('Wrote samples to public/samples/');
