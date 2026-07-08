const Database = require('better-sqlite3')
const db = new Database('E:/studycode/codetask/data/app.db', { readonly: true })

const jobs = db
  .prepare(
    `SELECT id, title, status, last_error FROM thread_jobs ORDER BY updated_at DESC LIMIT 3`
  )
  .all()
console.log('jobs', JSON.stringify(jobs, null, 2))

const slices = db
  .prepare(
    `SELECT job_id, slice_id, status, verification_status, last_error
     FROM job_plan_slices WHERE slice_id LIKE '%m1-s2%' OR slice_id LIKE 'm1-s2'`
  )
  .all()
console.log('slices', JSON.stringify(slices, null, 2))

const tasks = db
  .prepare(
    `SELECT job_id, task_id, status, task_status, last_error, evidence_json
     FROM job_tasks
     WHERE task_id LIKE '%m1-s2%' OR task_id LIKE '%m1-s1%'
     ORDER BY updated_at DESC LIMIT 20`
  )
  .all()
console.log('tasks', JSON.stringify(tasks, null, 2))

const artifacts = db
  .prepare(
    `SELECT id, job_id, kind, path, summary FROM job_artifacts
     WHERE job_id LIKE '%aa446618%' OR summary LIKE '%m1-s2%' OR path LIKE '%m1-s2%'
     LIMIT 20`
  )
  .all()
console.log('artifacts', JSON.stringify(artifacts, null, 2))
