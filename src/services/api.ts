import * as handlers from '../mocks/handlers';

export const api = {
  register: handlers.register,
  login: handlers.login,
  me: handlers.me,
  listModels: handlers.listModels,
  listMyModels: handlers.listMyModels,
  createModel: handlers.createModel,
  listAttachments: handlers.listAttachments,
  uploadAttachment: handlers.uploadAttachment,
  removeAttachment: handlers.removeAttachment
};
