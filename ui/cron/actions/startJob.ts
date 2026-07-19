import prisma from '../prisma';
import { Job } from '@prisma/client';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { TOOLKIT_ROOT, getTrainingFolder, getHFToken } from '../paths';
import { resolvePythonPath } from '../pythonPath';
const isWindows = process.platform === 'win32';

const markJobFailed = async (jobID: string, info: string) => {
  try {
    await prisma.job.update({
      where: { id: jobID },
      data: { status: 'error', info },
    });
  } catch (e) {
    console.error(`Error marking job ${jobID} as failed:`, e);
  }
};

const startAndWatchJob = (job: Job) => {
  // starts and watches the job asynchronously
  return new Promise<void>(async (resolve, reject) => {
    const jobID = job.id;

    // setup the training
    const trainingRoot = await getTrainingFolder();

    const trainingFolder = path.join(trainingRoot, job.name);
    if (!fs.existsSync(trainingFolder)) {
      fs.mkdirSync(trainingFolder, { recursive: true });
    }

    // make the config file
    const configPath = path.join(trainingFolder, '.job_config.json');

    //log to path
    const logPath = path.join(trainingFolder, 'log.txt');

    try {
      // if the log path exists, move it to a folder called logs and rename it {num}_log.txt, looking for the highest num
      // if the log path does not exist, create it
      if (fs.existsSync(logPath)) {
        const logsFolder = path.join(trainingFolder, 'logs');
        if (!fs.existsSync(logsFolder)) {
          fs.mkdirSync(logsFolder, { recursive: true });
        }

        let num = 0;
        while (fs.existsSync(path.join(logsFolder, `${num}_log.txt`))) {
          num++;
        }

        fs.renameSync(logPath, path.join(logsFolder, `${num}_log.txt`));
      }
    } catch (e) {
      console.error('Error moving log file:', e);
    }

    // update the config dataset path
    const jobConfig = JSON.parse(job.job_config);
    jobConfig.config.process[0].sqlite_db_path = path.join(TOOLKIT_ROOT, 'aitk_db.db');

    // write the config file
    fs.writeFileSync(configPath, JSON.stringify(jobConfig, null, 2));

    const pythonPath = resolvePythonPath();

    const runFilePath = path.join(TOOLKIT_ROOT, 'run.py');
    if (!fs.existsSync(runFilePath)) {
      console.error(`run.py not found at path: ${runFilePath}`);
      await prisma.job.update({
        where: { id: jobID },
        data: {
          status: 'error',
          info: `Error launching job: run.py not found`,
        },
      });
      return;
    }

    const additionalEnv: any = {
      AITK_JOB_ID: jobID,
      CUDA_DEVICE_ORDER: 'PCI_BUS_ID',
      CUDA_VISIBLE_DEVICES: `${job.gpu_ids}`,
      IS_AI_TOOLKIT_UI: '1',
    };

    // HF_TOKEN
    const hfToken = await getHFToken();
    if (hfToken && hfToken.trim() !== '') {
      additionalEnv.HF_TOKEN = hfToken;
    }

    // Add the --log argument to the command
    const args = [runFilePath, configPath, '--log', logPath];

    // Capture stderr in a file so crashes before the trainer takes over
    // (bad interpreter, import errors, ...) are not lost. A file descriptor
    // does not tie the child to the parent, so it can still be detached.
    const stderrPath = path.join(trainingFolder, 'stderr.log');
    let stderrFd: number | null = null;
    try {
      stderrFd = fs.openSync(stderrPath, 'w');
    } catch (e) {
      console.error('Error opening stderr log file:', e);
    }
    const stdio: any = ['ignore', 'ignore', stderrFd ?? 'ignore'];

    try {
      let subprocess;

      if (isWindows) {
        // Spawn Python directly on Windows so the process can survive parent exit
        subprocess = spawn(pythonPath, args, {
          env: {
            ...process.env,
            ...additionalEnv,
          },
          cwd: TOOLKIT_ROOT,
          detached: true,
          windowsHide: true,
          stdio, // don't tie stdio to parent
        });
      } else {
        // For non-Windows platforms, fully detach so it survives daemon-like
        subprocess = spawn(pythonPath, args, {
          detached: true,
          stdio,
          env: {
            ...process.env,
            ...additionalEnv,
          },
          cwd: TOOLKIT_ROOT,
        });
      }

      // spawn() does not throw when the binary is missing; it emits an
      // async 'error' event instead, so without this the job would sit at
      // "Starting job..." forever.
      subprocess.on('error', async (error: any) => {
        console.error(`Error launching job ${jobID}:`, error);
        await markJobFailed(jobID, `Error launching job: ${error?.message || 'Unknown error'} (${pythonPath})`);
      });

      // Best-effort watch for early crashes (e.g. import errors in a broken
      // python env). A healthy run updates its own status via the sqlite db,
      // so only flag the job if it died while still marked as running.
      subprocess.on('exit', async (code: number | null) => {
        if (code === null || code === 0) {
          return;
        }
        const currentJob = await prisma.job.findUnique({ where: { id: jobID } });
        if (currentJob?.status !== 'running') {
          return;
        }
        let stderrTail = '';
        try {
          const stderr = fs.readFileSync(stderrPath, 'utf-8').trim();
          stderrTail = stderr.slice(-1000);
        } catch (e) {
          // ignore, report the exit code only
        }
        await markJobFailed(jobID, `Job exited with code ${code}${stderrTail ? `: ${stderrTail}` : ''}`);
      });

      // The child has its own copy of the stderr descriptor
      if (stderrFd != null) {
        fs.closeSync(stderrFd);
      }

      // Save the PID to the database and a file for future management (stop/inspect)
      const pid = subprocess.pid ?? null;
      if (pid != null) {
        await prisma.job.update({
          where: { id: jobID },
          data: { pid },
        });
      }
      try {
        fs.writeFileSync(path.join(trainingFolder, 'pid.txt'), String(pid ?? ''), { flag: 'w' });
      } catch (e) {
        console.error('Error writing pid file:', e);
      }

      // Important: let the child run independently of this Node process.
      if (subprocess.unref) {
        subprocess.unref();
      }

      // (No stdout/stderr listeners — logging should go to --log handled by your Python)
      // (No monitoring loop — the whole point is to let it live past this worker)
    } catch (error: any) {
      // Handle any exceptions during process launch
      console.error('Error launching process:', error);

      await prisma.job.update({
        where: { id: jobID },
        data: {
          status: 'error',
          info: `Error launching job: ${error?.message || 'Unknown error'}`,
        },
      });
      return;
    }
    // Resolve the promise immediately after starting the process
    resolve();
  });
};

export default async function startJob(jobID: string) {
  const job: Job | null = await prisma.job.findUnique({
    where: { id: jobID },
  });
  if (!job) {
    console.error(`Job with ID ${jobID} not found`);
    return;
  }
  // update job status to 'running', this will run sync so we don't start multiple jobs.
  await prisma.job.update({
    where: { id: jobID },
    data: {
      status: 'running',
      stop: false,
      info: 'Starting job...',
    },
  });
  // start and watch the job asynchronously so the cron can continue
  startAndWatchJob(job);
}
