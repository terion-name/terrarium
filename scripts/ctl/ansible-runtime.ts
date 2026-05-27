export const TERRARIUM_ANSIBLE_VERSION = "13.7.0";
export const TERRARIUM_ANSIBLE_VENV = process.env.TERRARIUM_ANSIBLE_VENV ?? "/opt/terrarium/ansible-venv";
export const TERRARIUM_ANSIBLE_PYTHON = `${TERRARIUM_ANSIBLE_VENV}/bin/python`;
export const TERRARIUM_ANSIBLE_GALAXY = `${TERRARIUM_ANSIBLE_VENV}/bin/ansible-galaxy`;
export const TERRARIUM_ANSIBLE_PLAYBOOK = `${TERRARIUM_ANSIBLE_VENV}/bin/ansible-playbook`;
